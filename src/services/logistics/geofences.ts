// Geofence zone shapes from the relay's /ais/geofences endpoint (proxied through
// /api/ais-geofences on the web, direct to the relay in local dev). Consumed by the
// ferry.html "Zones" overlay — rendered as coloured circles/polygons on the map.

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

function toGeofence(row: unknown): Geofence | null {
  if (!row || typeof row !== 'object') return null;
  const r = row as Record<string, unknown>;
  const g = r.geometry as Record<string, unknown> | undefined;
  if (typeof r.id !== 'string' || !g) return null;
  if (g.type === 'circle') {
    const c = g.center as Record<string, unknown> | undefined;
    if (!c || !Number.isFinite(Number(c.lat)) || !Number.isFinite(Number(c.lon))) return null;
    return {
      id: r.id,
      portId: typeof r.portId === 'string' ? r.portId : undefined,
      name: typeof r.name === 'string' ? r.name : r.id,
      kind: typeof r.kind === 'string' ? r.kind : 'custom',
      geometry: { type: 'circle', center: { lat: Number(c.lat), lon: Number(c.lon) }, radiusKm: Number(g.radiusKm) || 8 },
      style: r.style as Geofence['style'],
      enabled: r.enabled !== false,
    };
  }
  if (g.type === 'polygon' && Array.isArray(g.ring)) {
    const ring = g.ring
      .map((p) => (p && typeof p === 'object' ? { lat: Number((p as Record<string, unknown>).lat), lon: Number((p as Record<string, unknown>).lon) } : null))
      .filter((p): p is { lat: number; lon: number } => !!p && Number.isFinite(p.lat) && Number.isFinite(p.lon));
    if (ring.length < 3) return null;
    return {
      id: r.id,
      portId: typeof r.portId === 'string' ? r.portId : undefined,
      name: typeof r.name === 'string' ? r.name : r.id,
      kind: typeof r.kind === 'string' ? r.kind : 'custom',
      geometry: { type: 'polygon', ring },
      style: r.style as Geofence['style'],
      enabled: r.enabled !== false,
    };
  }
  return null;
}

async function fetchGeofences(base: string): Promise<Geofence[]> {
  const res = await fetch(base, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`ais-geofences request failed: ${res.status}`);
  const data = await res.json();
  const rows: unknown = (data as { geofences?: unknown })?.geofences;
  if (!Array.isArray(rows)) return [];
  const out: Geofence[] = [];
  for (const row of rows) {
    const gf = toGeofence(row);
    if (gf && gf.enabled) out.push(gf);
  }
  return out;
}

/** Fetch the geofence zone shapes, with a local-relay fallback in dev. */
export async function getGeofences(baseUrl: string = GEOFENCES_PROXY_URL): Promise<Geofence[]> {
  try {
    return await fetchGeofences(baseUrl);
  } catch (err) {
    if (
      typeof window !== 'undefined' &&
      window.location.hostname === 'localhost' &&
      baseUrl !== LOCAL_RELAY_GEOFENCES_URL
    ) {
      return fetchGeofences(LOCAL_RELAY_GEOFENCES_URL);
    }
    throw err;
  }
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

export interface GeofenceFeatureProps {
  id: string;
  name: string;
  kind: string;
  color: string;
  fillOpacity: number;
}

/** One geofence → a GeoJSON Polygon Feature carrying its render style. */
export function geofenceToFeature(gf: Geofence): GeoJSON.Feature<GeoJSON.Polygon, GeofenceFeatureProps> {
  const ring =
    gf.geometry.type === 'circle'
      ? circleRing(gf.geometry.center, gf.geometry.radiusKm)
      : gf.geometry.ring.map((p) => [p.lon, p.lat] as [number, number]);
  return {
    type: 'Feature',
    geometry: { type: 'Polygon', coordinates: [ring] },
    properties: {
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
