// Live MapLibre map for the Italy Ferry Tracker.
//
// Reuses the same keyless Carto dark-matter basemap the main dashboard uses.
// Ferries are a single GeoJSON source updated in place on every poll: stationary
// vessels render as coloured dots, under-way vessels as arrows rotated to their
// course. Pan/zoom is enabled. Requires the tile host to be allowed by the
// page CSP (see ferry.html).

import maplibregl from 'maplibre-gl';
import { escapeHtml } from '@/utils/sanitize';
import { EUROPE_BBOX, type Bbox } from '@/config/italy-ferries';
import { ferriesToGeoJSON, ferryProps, type FerryFeatureProps } from '@/services/logistics/ferry-geojson';
import { geofencesToGeoJSON, type Geofence } from '@/services/logistics/geofences';
import type { TrackedFerry } from '@/services/logistics/ferry-tracker';
import { fetchTripByMmsi, type TripDetail } from '@/services/logistics/trip-detail';
import { VoyageReplay } from './VoyageReplay';

// Same basemap as DeckGLMap (keyless Carto vector style).
const DARK_STYLE = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json';
const SOURCE_ID = 'ferries';
const GEOFENCE_SOURCE_ID = 'geofences';
const GEOFENCE_LAYERS = ['geofence-fill', 'geofence-line'];
const ARROW_ICON = 'ferry-arrow';

// bbox is [latMin, lonMin, latMax, lonMax]; MapLibre wants [[w,s],[e,n]].
const toMapBounds = (b: Bbox): [[number, number], [number, number]] => [
  [b[1], b[0]],
  [b[3], b[2]],
];
const BOUNDS = toMapBounds(EUROPE_BBOX);

const STATUS_MATCH = [
  'match', ['get', 'status'],
  'under_way', '#2fbf85',
  'at_anchor', '#e0a032',
  'in_port', '#9aa0a6',
  '#9aa0a6',
] as const;

const INTERACTIVE_LAYERS = ['ferry-dots', 'ferry-arrows'];

// Status -> colour, matching the legend and the map markers.
const STATUS_COLOR: Record<string, string> = {
  under_way: '#2fbf85',
  at_anchor: '#e0a032',
  in_port: '#9aa0a6',
};

function popupHtml(p: FerryFeatureProps): string {
  // The dot colour already conveys status (same colours as the markers/legend),
  // so the destination line shows a status dot instead of repeating the words.
  const color = STATUS_COLOR[p.status] ?? '#9aa0a6';
  const dest = p.destinationName ? `→ ${escapeHtml(p.destinationName)}` : 'destination unknown';
  const operator = p.operatorName ? `<div class="ferry-popup-op">${escapeHtml(p.operatorName)}</div>` : '';

  // Optional detail lines — only rendered when the vessel broadcast the data.
  const detail: string[] = [];
  const sizeDraught = [p.sizeText, p.draughtText].filter(Boolean).map(escapeHtml).join(' · ');
  if (sizeDraught) detail.push(`<div class="ferry-popup-row ferry-popup-dim">${sizeDraught}</div>`);
  const idEta = [
    p.callSign ? `Call ${escapeHtml(p.callSign)}` : '',
    p.etaAisText ? `Crew ETA ${escapeHtml(p.etaAisText)}` : '',
  ].filter(Boolean).join(' · ');
  if (idEta) detail.push(`<div class="ferry-popup-row ferry-popup-dim">${idEta}</div>`);

  const delay = p.delayText
    ? `<div class="ferry-popup-row ferry-popup-delay">⚠ ${escapeHtml(p.delayText)}</div>`
    : '';
  const why = p.whyText
    ? `<div class="ferry-popup-row ferry-popup-why">${escapeHtml(p.whyText)}</div>`
    : '';

  return `<div class="ferry-popup">
    <div class="ferry-popup-name">${escapeHtml(p.name)}</div>
    ${operator}
    <div class="ferry-popup-row"><span class="ferry-popup-dot" style="background:${color}" title="${escapeHtml(p.statusLabel)}"></span>${dest}</div>
    <div class="ferry-popup-row">${escapeHtml(p.speedText)} · ETA ${escapeHtml(p.etaText)}</div>
    ${delay}
    ${why}
    ${detail.join('')}
  </div>`;
}

// Voyage (get_trip) rendering — chip labels + a duration formatter.
const CHIP_LABEL: Record<string, string> = { distanceKm: 'Distance', avgSpeedKn: 'Speed', destDwellMin: 'Dwell', track: 'Track', status: 'Status' };
function fmtDuration(min: number): string {
  if (min < 60) return `${Math.round(min)} min`;
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return m ? `${h}h ${m}m` : `${h}h`;
}

/**
 * The voyage block appended under the vessel popup once its trip loads. A suppressed/annotated field
 * renders as a caveat chip (e.g. "Distance: origin not observed") — never a bare 0 — which is the
 * whole point of the Phase C sufficiency gate.
 */
function voyageHtml(d: TripDetail): string {
  if (!d.found || !d.trip) return '';
  const t = d.trip;
  const n = d.notes;
  const route = `${escapeHtml(t.origin || '—')} → ${escapeHtml(t.dest || '—')}`;
  const rows: string[] = [];
  if (t.distanceKm != null) {
    const spd = t.avgSpeedKn != null ? ` · ~${Math.round(t.avgSpeedKn)} kn` : '';
    rows.push(`<div class="ferry-popup-row ferry-popup-dim">${Math.round(t.distanceKm)} km${spd}</div>`);
  }
  if (t.durationMin != null) rows.push(`<div class="ferry-popup-row ferry-popup-dim">${fmtDuration(t.durationMin)} under way</div>`);
  if (t.destDwellMin != null) rows.push(`<div class="ferry-popup-row ferry-popup-dim">${Math.round(t.destDwellMin)} min at destination</div>`);
  if (d.track && d.track.length) rows.push(`<div class="ferry-popup-row ferry-popup-dim">${d.pointCount} track points${d.densityPerHr ? ` · ~${d.densityPerHr}/hr` : ''}</div>`);
  const chips = ['distanceKm', 'avgSpeedKn', 'destDwellMin', 'track', 'status']
    .map((f) => {
      const note = n[f];
      return note ? `<div class="ferry-popup-chip">${escapeHtml(CHIP_LABEL[f] ?? f)}: ${escapeHtml(note)}</div>` : '';
    })
    .join('');
  return `<div class="ferry-popup-voyage">
    <div class="ferry-popup-voyage-title">Voyage · ${escapeHtml(t.status)}</div>
    <div class="ferry-popup-row">${route}</div>
    ${rows.join('')}
    ${chips}
  </div>`;
}


export class ItalyFerryMap {
  private map: maplibregl.Map;
  private ready = false;
  private pending: TrackedFerry[] | null = null;
  private pendingGeofences: Geofence[] | null = null;
  private zonesVisible = false;
  private popup: maplibregl.Popup;
  private replay: VoyageReplay | null = null;   // voyage replay overlay (route + trail + waypoints + playhead)
  private selectedMmsi: string | null = null; // the vessel whose voyage is loading/shown (drops stale fetches)

  constructor(container: HTMLElement) {
    this.map = new maplibregl.Map({
      container,
      style: DARK_STYLE,
      bounds: BOUNDS,
      fitBoundsOptions: { padding: 24 },
      renderWorldCopies: false,
      attributionControl: { compact: true },
      maxPitch: 0,
      dragRotate: false,
      pitchWithRotate: false,
    });
    this.popup = new maplibregl.Popup({ closeButton: true, closeOnClick: true, offset: 12 });
    this.popup.on('close', () => { this.selectedMmsi = null; this.replay?.clear(); });
    this.map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    this.map.on('load', () => this.onLoad());
  }

  private onLoad(): void {
    this.addArrowIcon();

    // Geofence zones render UNDER the vessels (added first). Hidden until toggled on.
    this.map.addSource(GEOFENCE_SOURCE_ID, { type: 'geojson', data: geofencesToGeoJSON([]) });
    this.map.addLayer({
      id: 'geofence-fill',
      type: 'fill',
      source: GEOFENCE_SOURCE_ID,
      layout: { visibility: 'none' },
      paint: { 'fill-color': ['get', 'color'], 'fill-opacity': ['get', 'fillOpacity'] },
    });
    this.map.addLayer({
      id: 'geofence-line',
      type: 'line',
      source: GEOFENCE_SOURCE_ID,
      layout: { visibility: 'none' },
      paint: { 'line-color': ['get', 'color'], 'line-width': 1.2, 'line-opacity': 0.7 },
    });

    // Voyage replay (Phase C): its route/trail/waypoints/playhead render UNDER the vessels (added first).
    this.replay = new VoyageReplay(this.map);

    this.map.addSource(SOURCE_ID, { type: 'geojson', data: ferriesToGeoJSON([]) });

    // Coloured dot for stationary vessels (and as a base for moving ones).
    this.map.addLayer({
      id: 'ferry-dots',
      type: 'circle',
      source: SOURCE_ID,
      filter: ['!', ['get', 'moving']],
      paint: {
        'circle-radius': 5,
        'circle-color': STATUS_MATCH as unknown as maplibregl.ExpressionSpecification,
        'circle-stroke-color': '#0b0d0f',
        'circle-stroke-width': 1,
      },
    });

    // Arrow oriented to heading for under-way vessels (SDF icon tinted by status).
    this.map.addLayer({
      id: 'ferry-arrows',
      type: 'symbol',
      source: SOURCE_ID,
      filter: ['get', 'moving'],
      layout: {
        'icon-image': ARROW_ICON,
        'icon-rotate': ['get', 'courseDeg'],
        'icon-rotation-alignment': 'map',
        'icon-allow-overlap': true,
        'icon-size': 0.9,
      },
      paint: {
        'icon-color': STATUS_MATCH as unknown as maplibregl.ExpressionSpecification,
        'icon-halo-color': '#0b0d0f',
        'icon-halo-width': 1,
      },
    });

    // Vessel name labels.
    this.map.addLayer({
      id: 'ferry-labels',
      type: 'symbol',
      source: SOURCE_ID,
      layout: {
        'text-field': ['get', 'name'],
        'text-size': 11,
        'text-offset': [0.9, 0],
        'text-anchor': 'left',
        'text-allow-overlap': false,
      },
      paint: {
        'text-color': '#e8eaed',
        'text-halo-color': '#0b0d0f',
        'text-halo-width': 1.2,
      },
    });

    this.wireInteractions();

    this.ready = true;
    if (this.pending) {
      this.setFerries(this.pending);
      this.pending = null;
    }
    if (this.pendingGeofences) {
      this.setGeofences(this.pendingGeofences);
      this.pendingGeofences = null;
    }
    this.applyZonesVisibility();
  }

  /** Click a vessel for a popup; pointer cursor on hover. */
  private wireInteractions(): void {
    for (const id of INTERACTIVE_LAYERS) {
      this.map.on('click', id, (e) => {
        const feature = e.features?.[0];
        if (!feature) return;
        const props = feature.properties as unknown as FerryFeatureProps;
        const coords = (feature.geometry as GeoJSON.Point).coordinates as [number, number];
        this.popup.setLngLat(coords).setHTML(popupHtml(props)).addTo(this.map);
        void this.loadVoyage(props);
      });
      this.map.on('mouseenter', id, () => { this.map.getCanvas().style.cursor = 'pointer'; });
      this.map.on('mouseleave', id, () => { this.map.getCanvas().style.cursor = ''; });
    }
  }

  /** Fly to a vessel and open its popup — used when a table row is clicked. */
  public focusFerry(ferry: TrackedFerry): void {
    if (!this.ready) return;
    const center: [number, number] = [ferry.lon, ferry.lat];
    const props = ferryProps(ferry);
    this.map.flyTo({ center, zoom: Math.max(this.map.getZoom(), 9), speed: 1.2 });
    this.popup.setLngLat(center).setHTML(popupHtml(props)).addTo(this.map);
    void this.loadVoyage(props);
  }

  /**
   * Fetch the clicked vessel's latest/open trip and, if it's still the selected vessel when the fetch
   * resolves (guards against a rapid re-click), draw its track + append the voyage block to the popup.
   * Best-effort: a failure leaves the vessel popup as-is.
   */
  private async loadVoyage(props: FerryFeatureProps): Promise<void> {
    const mmsi = props.mmsi;
    this.selectedMmsi = mmsi;
    this.replay?.clear();
    let detail: TripDetail;
    try {
      detail = await fetchTripByMmsi(mmsi);
    } catch {
      return; // relay/proxy hiccup — the vessel popup still stands
    }
    if (this.selectedMmsi !== mmsi || !detail.found) return; // superseded by another click, or no trip
    if (detail.track && detail.track.length) this.replay?.load(detail.track); // replay overlay + controls
    this.popup.setHTML(popupHtml(props) + voyageHtml(detail));
  }

  /** Build an upward-pointing arrow as an SDF icon so it can be tinted per status. */
  private addArrowIcon(): void {
    if (this.map.hasImage(ARROW_ICON)) return;
    const size = 20;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.beginPath();
    ctx.moveTo(size / 2, 1);
    ctx.lineTo(size - 3, size - 2);
    ctx.lineTo(size / 2, size * 0.6);
    ctx.lineTo(3, size - 2);
    ctx.closePath();
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    const img = ctx.getImageData(0, 0, size, size);
    this.map.addImage(ARROW_ICON, img, { pixelRatio: 2, sdf: true });
  }

  /** Update the plotted ferries in place (no map teardown). */
  public setFerries(ferries: TrackedFerry[]): void {
    if (!this.ready) {
      this.pending = ferries;
      return;
    }
    const source = this.map.getSource(SOURCE_ID) as maplibregl.GeoJSONSource | undefined;
    source?.setData(ferriesToGeoJSON(ferries) as unknown as GeoJSON.FeatureCollection);
  }

  /** Update the geofence zone shapes in place. */
  public setGeofences(geofences: Geofence[]): void {
    if (!this.ready) {
      this.pendingGeofences = geofences;
      return;
    }
    const source = this.map.getSource(GEOFENCE_SOURCE_ID) as maplibregl.GeoJSONSource | undefined;
    source?.setData(geofencesToGeoJSON(geofences) as unknown as GeoJSON.FeatureCollection);
  }

  /** Show/hide the geofence zone overlay. */
  public setZonesVisible(visible: boolean): void {
    this.zonesVisible = visible;
    this.applyZonesVisibility();
  }

  private applyZonesVisibility(): void {
    if (!this.ready) return;
    const visibility = this.zonesVisible ? 'visible' : 'none';
    for (const id of GEOFENCE_LAYERS) this.map.setLayoutProperty(id, 'visibility', visibility);
  }

  /** Zoom/pan to a region's bounding box — used when the region filter changes. */
  public fitBbox(bbox: Bbox): void {
    this.map.fitBounds(toMapBounds(bbox), { padding: 24, duration: 600 });
  }

  public destroy(): void {
    this.map.remove();
  }
}
