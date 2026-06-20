// Live MapLibre map for the Italy Ferry Tracker.
//
// Reuses the same keyless Carto dark-matter basemap the main dashboard uses.
// Ferries are a single GeoJSON source updated in place on every poll: stationary
// vessels render as coloured dots, under-way vessels as arrows rotated to their
// course. Pan/zoom is enabled. Requires the tile host to be allowed by the
// page CSP (see ferry.html).

import maplibregl from 'maplibre-gl';
import { ITALY_BBOX } from '@/config/italy-ferries';
import { ferriesToGeoJSON } from '@/services/logistics/ferry-geojson';
import type { TrackedFerry } from '@/services/logistics/ferry-tracker';

// Same basemap as DeckGLMap (keyless Carto vector style).
const DARK_STYLE = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json';
const SOURCE_ID = 'ferries';
const ARROW_ICON = 'ferry-arrow';

// bbox is [latMin, lonMin, latMax, lonMax]; MapLibre wants [[w,s],[e,n]].
const BOUNDS: [[number, number], [number, number]] = [
  [ITALY_BBOX[1], ITALY_BBOX[0]],
  [ITALY_BBOX[3], ITALY_BBOX[2]],
];

const STATUS_MATCH = [
  'match', ['get', 'status'],
  'under_way', '#2fbf85',
  'at_anchor', '#e0a032',
  'in_port', '#9aa0a6',
  '#9aa0a6',
] as const;

export class ItalyFerryMap {
  private map: maplibregl.Map;
  private ready = false;
  private pending: TrackedFerry[] | null = null;

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
    this.map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    this.map.on('load', () => this.onLoad());
  }

  private onLoad(): void {
    this.addArrowIcon();
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

    this.ready = true;
    if (this.pending) {
      this.setFerries(this.pending);
      this.pending = null;
    }
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

  public destroy(): void {
    this.map.remove();
  }
}
