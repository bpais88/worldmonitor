// Geofence zone shapes from the relay's /ais/geofences endpoint (proxied through
// /api/ais-geofences on the web, direct to the relay in local dev). Consumed by the
// ferry.html "Zones" overlay — rendered as coloured circles/polygons on the map.

import { relayFetch } from './relay-fetch';

const GEOFENCES_PROXY_URL = '/api/ais-geofences';
const LOCAL_RELAY_GEOFENCES_URL = 'http://localhost:3004/ais/geofences';

export type GeofenceGeometry =
  | { type: 'circle'; center: { lat: number; lon: number }; radiusKm: number }
  | { type: 'polygon'; ring: { lat: number; lon: number }[] };

export interface Geofence {
  id: string;
  portId?: string;
  name: string;
  kind: string; // 'port' | 'anchorage' | 'chokepoint' | 'risk' | 'custom'
  geometry: GeofenceGeometry;
  style?: { color?: string; fillOpacity?: number };
  enabled?: boolean;
}

const DEFAULT_COLOR = '#2fbf85';
const DEFAULT_FILL_OPACITY = 0.08;

function parseGeometry(g: Record<string, unknown> | undefined): GeofenceGeometry | null {
  if (!g) return null;
  if (g.type === 'circle') {
    const c = g.center as Record<string, unknown> | undefined;
    if (!c || !Number.isFinite(Number(c.lat)) || !Number.isFinite(Number(c.lon))) return null;
    return { type: 'circle', center: { lat: Number(c.lat), lon: Number(c.lon) }, radiusKm: Number(g.radiusKm) || 8 };
  }
  if (g.type === 'polygon' && Array.isArray(g.ring)) {
    const ring = g.ring
      .map((p) => (p && typeof p === 'object'
        ? { lat: Number((p as Record<string, unknown>).lat), lon: Number((p as Record<string, unknown>).lon) }
        : null))
      .filter((p): p is { lat: number; lon: number } => !!p && Number.isFinite(p.lat) && Number.isFinite(p.lon));
    return ring.length >= 3 ? { type: 'polygon', ring } : null;
  }
  return null;
}

function toGeofence(row: unknown): Geofence | null {
  if (!row || typeof row !== 'object') return null;
  const r = row as Record<string, unknown>;
  if (typeof r.id !== 'string') return null;
  const geometry = parseGeometry(r.geometry as Record<string, unknown> | undefined);
  if (!geometry) return null;
  return {
    id: r.id,
    portId: typeof r.portId === 'string' ? r.portId : undefined,
    name: typeof r.name === 'string' ? r.name : r.id,
    kind: typeof r.kind === 'string' ? r.kind : 'custom',
    geometry,
    style: r.style as Geofence['style'],
    enabled: r.enabled !== false,
  };
}

function parseGeofences(json: unknown): Geofence[] {
  const rows: unknown = (json as { geofences?: unknown })?.geofences;
  if (!Array.isArray(rows)) return [];
  const out: Geofence[] = [];
  for (const row of rows) {
    const gf = toGeofence(row);
    if (gf && gf.enabled) out.push(gf);
  }
  return out;
}

/** Fetch the geofence zone shapes, with a local-relay fallback in dev. */
export function getGeofences(): Promise<Geofence[]> {
  return relayFetch(GEOFENCES_PROXY_URL, LOCAL_RELAY_GEOFENCES_URL, parseGeofences);
}

// ── GeoJSON conversion (for MapLibre) ──────────────────────────────────────
// MapLibre has no geographic-circle primitive (circle-radius is in pixels), so a
// circle geofence is approximated as a polygon ring that scales correctly with zoom.

const KM_PER_DEG_LAT = 110.574;
const KM_PER_DEG_LON_EQ = 111.320;

/** A closed ring of [lon, lat] approximating a circle (equirectangular, fine at these radii). */
function circleRing(center: { lat: number; lon: number }, radiusKm: number, steps = 64): [number, number][] {
  const latR = radiusKm / KM_PER_DEG_LAT;
  const lonR = radiusKm / (KM_PER_DEG_LON_EQ * Math.cos((center.lat * Math.PI) / 180));
  const ring: [number, number][] = [];
  for (let i = 0; i <= steps; i++) {
    const theta = (i / steps) * 2 * Math.PI;
    ring.push([center.lon + lonR * Math.cos(theta), center.lat + latR * Math.sin(theta)]);
  }
  return ring;
}

interface GeofenceFeatureProps {
  id: string;
  name: string;
  kind: string;
  color: string;
  fillOpacity: number;
  /** Radius in km, or 0 for a polygon zone. Used to select circle zones for the marker layer. */
  radiusKm: number;
  /**
   * The zone's on-screen radius in pixels AT ZOOM 0. Multiply by 2^zoom for the radius at any
   * zoom — that is the whole conversion, and it is exact.
   *
   * Why this is precomputed here rather than derived in the style expression: the polygon ring
   * alone cannot be drawn legibly when zoomed out. A ring is in METRES, so at the board's default
   * European view (z3.5) the largest zone we carry, Rotterdam at 20 km, measures 4.6px across and
   * Venezia at 2.5 km measures 0.5px — the "Port zones" toggle switched on and nothing visibly
   * happened. So the map floors the size at low zoom, which needs a scalar.
   *
   * Metres-per-pixel depends on LATITUDE (Web Mercator, 512px tiles: 78271.516·cos φ / 2^zoom),
   * and a MapLibre expression cannot read a feature's latitude. Assuming a fixed latitude instead
   * is off by +26% at Algeciras (36.1°N) and −9% at Teesport (54.6°N) over the zones we actually
   * carry, which would also make the ring visibly jump when the marker hands over to the true
   * geometry. Baking cos φ in at build time removes both problems.
   */
  radiusPxAtZoom0: number;
}

// Web Mercator, MapLibre's 512px-tile convention: metres per pixel = MERCATOR_M_PER_PX_Z0·cos φ / 2^zoom.
const MERCATOR_M_PER_PX_Z0 = 78271.516;

/** One geofence → a GeoJSON Polygon Feature carrying its render style. */
function geofenceToFeature(gf: Geofence): GeoJSON.Feature<GeoJSON.Polygon, GeofenceFeatureProps> {
  const ring =
    gf.geometry.type === 'circle'
      ? circleRing(gf.geometry.center, gf.geometry.radiusKm)
      : gf.geometry.ring.map((p) => [p.lon, p.lat] as [number, number]);
  return {
    type: 'Feature',
    geometry: { type: 'Polygon', coordinates: [ring] },
    properties: {
      radiusKm: gf.geometry.type === 'circle' ? gf.geometry.radiusKm : 0,
      radiusPxAtZoom0:
        gf.geometry.type === 'circle'
          ? (gf.geometry.radiusKm * 1000)
            / (MERCATOR_M_PER_PX_Z0 * Math.cos((gf.geometry.center.lat * Math.PI) / 180))
          : 0,
      id: gf.id,
      name: gf.name,
      kind: gf.kind,
      color: gf.style?.color ?? DEFAULT_COLOR,
      fillOpacity: gf.style?.fillOpacity ?? DEFAULT_FILL_OPACITY,
    },
  };
}

export function geofencesToGeoJSON(geofences: Geofence[]): GeoJSON.FeatureCollection<GeoJSON.Polygon, GeofenceFeatureProps> {
  return { type: 'FeatureCollection', features: geofences.map(geofenceToFeature) };
}
