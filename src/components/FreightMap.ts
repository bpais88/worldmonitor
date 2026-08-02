// Live MapLibre map for the Italy Ferry Tracker.
//
// Reuses the same keyless Carto dark-matter basemap the main dashboard uses.
// Ferries are a single GeoJSON source updated in place on every poll: stationary
// vessels render as coloured dots, under-way vessels as arrows rotated to their
// course. Pan/zoom is enabled. Requires the tile host to be allowed by the
// page CSP (see ferry.html).

import maplibregl from 'maplibre-gl';
import { escapeHtml } from '@/utils/sanitize';
import { EUROPE_BBOX, type Bbox } from '@/config/maritime-ports';
import { ferriesToGeoJSON, ferryProps, type FerryFeatureProps } from '@/services/logistics/ferry-geojson';
import { geofencesToGeoJSON, type Geofence } from '@/services/logistics/geofences';
import { portsToGeoJSON } from '@/services/logistics/ports-geojson';
import type { PortStatus } from '@/services/logistics/port-status';
import type { TrackedFerry } from '@/services/logistics/ferry-tracker';
import { fetchTripByMmsi, fetchTripById, type TripDetail } from '@/services/logistics/trip-detail';
import { VoyageReplay } from './VoyageReplay';

// Same basemap as DeckGLMap (keyless Carto vector style).
const DARK_STYLE = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json';
const SOURCE_ID = 'ferries';
const GEOFENCE_SOURCE_ID = 'geofences';
const GEOFENCE_LAYERS = ['geofence-fill', 'geofence-line'];
const ARROW_ICON = 'ferry-arrow';
const PORTS_SOURCE_ID = 'ports';
// Vessel dot size by zoom, instead of a flat 5px at every scale.
//
// Measured on the live feed at the default European view: 3,044 vessels on screen, and at r=5
// **77% of the painted area is dots drawing over each other**. That overlap is what turns the
// Channel and the North Sea into a single mass — not the number of ships. Dropping to r≈2.5 there
// halves the ink (6.5% -> 1.9% of the canvas) and cuts the wasted overlap, while still drawing
// EVERY vessel.
//
// Chosen over clustering deliberately. Clustering is the textbook fix and would replace ~3,000
// boats with ~20 numbered bubbles at this zoom — but seeing the actual boats move is the point of
// this board, so the fix must not delete them. Zoom back in and the dots grow to their old size.
const VESSEL_DOT_RADIUS = [
  'interpolate', ['linear'], ['zoom'],
  3, 2,
  5, 3,
  7, 4.5,
  10, 6,
] as const;
const PORT_LAYERS = ['port-queue-ring', 'port-circles', 'port-labels'];
// The table's congestion palette, so map and table never disagree about what "busy" looks like
// (ferry.html .port-congestion-*). `unknown` is deliberately a desaturated grey rather than a
// fourth hue: it must read as ABSENCE of information, not as a fourth severity.
// Radius by sqrt(atPort) so the DISC AREA tracks the count — the eye reads area, and a linear
// radius would make a 25-vessel port look 25x a 1-vessel one.
//
// The domain runs to sqrt(110) ~ 10.5, not to sqrt(49) as first drafted. Rotterdam currently sits
// at 104 vessels and Amsterdam at 67; a shorter domain clamped BOTH to the maximum, so the two
// busiest ports in Europe rendered identically. Caught by previewing the encoding against live data
// before shipping it.
//
// The top is also held to 20px rather than 24: Rotterdam, Amsterdam, Moerdijk and Vlissingen sit
// within ~50px of each other at European zoom, so an over-large maximum turns the single most
// important cluster on the map into one unreadable blob. Floor of 4px keeps an empty port visible
// and clickable.
const PORT_RADIUS = [
  'interpolate', ['linear'], ['sqrt', ['max', ['get', 'atPort'], 0]],
  0, 4,
  2, 7,
  4, 11,
  7, 16,
  10.5, 20,
] as const;

const PORT_FILL = [
  'match', ['get', 'level'],
  'congested', '#f06a62',
  'busy', '#e0a032',
  'clear', '#2fbf85',
  '#8b9199',
] as const;

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
  // Shareable deep-link (?trip=<id>): an arrived trip is immutable → a permanent voyage record;
  // an open one shares the live leg. Bound to a click handler after the popup HTML is set.
  const share = `<button type="button" class="ferry-share-btn" data-trip-id="${t.id}">🔗 ${t.status === 'arrived' ? 'Copy voyage link' : 'Copy live voyage link'}</button>`;
  return `<div class="ferry-popup-voyage">
    <div class="ferry-popup-voyage-title">Voyage · ${escapeHtml(t.status)}</div>
    <div class="ferry-popup-row">${route}</div>
    ${rows.join('')}
    ${chips}
    ${share}
  </div>`;
}

/** Popup header for a deep-linked trip (the vessel may not be on the live board any more). */
function tripHeaderHtml(d: TripDetail): string {
  const t = d.trip;
  if (!t) return '';
  const name = t.vesselName || `MMSI ${t.mmsi}`;
  const op = t.operator ? `<div class="ferry-popup-op">${escapeHtml(t.operator)}</div>` : '';
  return `<div class="ferry-popup">
    <div class="ferry-popup-name">${escapeHtml(name)}</div>
    ${op}
  </div>`;
}

/** Rewrite the `?trip=` param in place (no navigation) so the current voyage view is shareable. */
function setTripUrlParam(id: number | null): void {
  try {
    const url = new URL(window.location.href);
    if (id == null) url.searchParams.delete('trip');
    else url.searchParams.set('trip', String(id));
    window.history.replaceState(null, '', url);
  } catch { /* older browsers / sandboxed iframes — sharing is best-effort */ }
}


export class FreightMap {
  private map: maplibregl.Map;
  private ready = false;
  private pending: TrackedFerry[] | null = null;
  private pendingGeofences: Geofence[] | null = null;
  private pendingPorts: PortStatus[] | null = null;
  private portsVisible = false;
  private zonesVisible = false;
  private popup: maplibregl.Popup;
  private replay: VoyageReplay | null = null;   // voyage replay overlay (route + trail + waypoints + playhead)
  private pendingTripId: number | null = null;  // `?trip=` deep-link that arrived before the map was ready
  private voyageSeq = 0;                        // bumps on every selection/close; stale async voyage loads bail
  private selectedMmsi: string | null = null; // the vessel whose voyage is loading/shown (drops stale fetches)
  private resizeObserver: ResizeObserver | null = null; // see setupResizeObserver — this is load-bearing
  private userMoved = false;                            // once true, we stop re-framing on resize

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
    this.popup.on('close', () => { this.selectedMmsi = null; this.voyageSeq++; this.replay?.clear(); setTripUrlParam(null); });
    this.map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    this.map.on('load', () => this.onLoad());
    // Any drag/zoom/rotate the USER starts hands the viewport over to them for good. `originalEvent`
    // is what distinguishes a real gesture from our own flyTo/fitBounds calls, which also fire these.
    for (const ev of ['dragstart', 'zoomstart', 'rotatestart'] as const) {
      this.map.on(ev, (e: { originalEvent?: unknown }) => { if (e?.originalEvent) this.userMoved = true; });
    }
    this.setupResizeObserver(container);
  }

  /**
   * Re-measure whenever the host's box changes — WITHOUT this the map renders nothing at all.
   *
   * The panel builds its scaffold and constructs this map in the same synchronous pass, and hides
   * the host with `display:none` whenever the mode isn't "vessels". Either way MapLibre can latch a
   * zero-sized viewport at construction, and a zero viewport means NO TILE IS EVER IN VIEW: the
   * style, TileJSON and sprites all load (they are main-thread fetches that don't depend on the
   * viewport) while not one .pbf is ever requested. The result looks like a broken basemap rather
   * than a sizing bug, which is exactly why it survived — there is no error, no failed request, and
   * the host measures correctly by the time anyone inspects it.
   *
   * Observed in production: the map was blank until the browser window itself was resized, which
   * finally fired MapLibre's own observer; the full basemap and ~1,900 vessels then appeared at
   * once. DeckGLMap has had this observer since it was written (setupResizeObserver there) — this
   * map simply never got one, and relied on the panel remembering to call resize().
   */
  private setupResizeObserver(container: HTMLElement): void {
    this.resizeObserver = new ResizeObserver(() => {
      // Only meaningful once the host actually occupies space; resizing to 0x0 is a no-op that
      // would just re-latch the empty viewport.
      const { width, height } = container.getBoundingClientRect();
      if (width <= 0 || height <= 0) return;
      this.map.resize();
      // ...and RE-FRAME, which resize() alone does not do. resize() keeps centre and zoom and
      // simply reveals more geography, so a map that fitted EUROPE_BBOX into a small container at
      // construction stays at that low zoom when the container grows — showing Greenland to India
      // with the vessels crammed into a corner. Observed exactly that once the host became
      // viewport-relative. Re-fitting keeps the framing correct at every container size.
      //
      // Guarded on `userMoved` so this only ever corrects the INITIAL framing: the moment someone
      // pans or zooms, the view is theirs and a stray resize must not yank it back.
      if (!this.userMoved) this.map.fitBounds(BOUNDS, { padding: 24, duration: 0 });
    });
    this.resizeObserver.observe(container);
  }

  private onLoad(): void {
    // Re-measure once the style is actually ready. The ResizeObserver alone is NOT enough: when the
    // host already has its final size at construction, the observer fires exactly once — during
    // observe(), before the style has loaded — and then never again, because the box never changes.
    // A resize at that moment is a no-op, so the map is left having never run an update pass with a
    // live style and paints nothing. Verified in production: the map stayed black with the observer
    // deployed, and only appeared when the browser window was resized, which forced this same call
    // later in the lifecycle. Doing it here is that same kick, at the right time, every time.
    this.map.resize();
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

    // --- Ports (congestion) -------------------------------------------------------------------
    // Added BEFORE the vessels so ships always draw on top of the port discs. Hidden until the
    // board is in Ports mode.
    //
    // Three encodings, because a port has three things to say at once and one coloured dot can only
    // say one of them:
    //   radius -> HOW MANY are at the port      (sqrt so AREA tracks the count, not radius: a
    //                                            25-vessel port must not look 25x a 1-vessel port)
    //   fill   -> HOW BUSY that is FOR THIS PORT (congestionRel where available; see levelFor)
    //   ring   -> HOW MANY ARE QUEUED at anchor  (the leading indicator — a queue forms before a
    //                                            port reads congested)
    this.map.addSource(PORTS_SOURCE_ID, { type: 'geojson', data: portsToGeoJSON([]) });

    // Anchor queue: a wide, soft ring OUTSIDE the disc. Drawn first so the disc sits on top of it.
    this.map.addLayer({
      id: 'port-queue-ring',
      type: 'circle',
      source: PORTS_SOURCE_ID,
      layout: { visibility: 'none' },
      filter: ['>', ['get', 'atAnchor'], 0],
      paint: {
        'circle-radius': ['+', PORT_RADIUS as unknown as number, 5],
        'circle-color': 'transparent',
        'circle-stroke-color': '#e0a032',
        // Ring thickness grows with the queue, capped so a huge queue can't swamp its neighbours.
        'circle-stroke-width': ['interpolate', ['linear'], ['get', 'atAnchor'], 1, 1.5, 10, 4.5],
        'circle-stroke-opacity': 0.85,
      } as unknown as maplibregl.CircleLayerSpecification['paint'],
    });

    this.map.addLayer({
      id: 'port-circles',
      type: 'circle',
      source: PORTS_SOURCE_ID,
      layout: { visibility: 'none' },
      paint: {
        'circle-radius': PORT_RADIUS as unknown as number,
        'circle-color': PORT_FILL as unknown as string,
        // Uncovered ports are drawn hollow: the outline says "there is a port here", the missing
        // fill says "we cannot currently see it". Never let that read as clear (#125).
        'circle-opacity': ['case', ['get', 'coverageOk'], 0.55, 0.12],
        'circle-stroke-color': PORT_FILL as unknown as string,
        'circle-stroke-width': ['case', ['get', 'coverageOk'], 1.5, 1.5],
        'circle-stroke-opacity': 0.95,
      } as unknown as maplibregl.CircleLayerSpecification['paint'],
    });

    this.map.addLayer({
      id: 'port-labels',
      type: 'symbol',
      source: PORTS_SOURCE_ID,
      // Only label ports that actually have something to report. A map full of "· 0" is noise, and
      // those are exactly the labels that would crowd out the ones that matter.
      filter: ['>', ['get', 'atPort'], 0],
      layout: {
        visibility: 'none',
        // Draw ALWAYS, and control clutter by labelling FEWER ports when zoomed out instead.
        //
        // Three approaches were tried before this one. Collision on, layer after the basemap: every
        // label overlapping a country name lost, and one survived across all of Europe. Collision
        // off: they beat the basemap but stacked on each other in the Dutch cluster. Collision on,
        // layer inserted before the basemap's first symbol layer (waterway_label): they won
        // PLACEMENT — but style order sets draw order too, so they rendered underneath, and the
        // basemap's city labels ignore collision and painted straight over them. Rotterdam and
        // Amsterdam, the two that matter most, were invisible while Moerdijk and Felixstowe showed.
        //
        // Placement priority and draw order cannot be separated, so stop fighting it: draw on top
        // unconditionally, and keep the map readable by thinning the SET of labels by zoom.
        'text-allow-overlap': true,
        'text-ignore-placement': true,
        // Zoomed out, only ports with real activity are named — that alone empties the Dutch
        // pile-up, since Moerdijk/Vlissingen fall away while Rotterdam/Amsterdam stay. From z6 the
        // ports are far enough apart on screen that everything can be labelled.
        // (A `step` on zoom at the top level is the form MapLibre allows for a layout property that
        // also reads feature data.)
        'text-field': [
          'step', ['zoom'],
          ['case', ['>', ['get', 'atPort'], 8], ['get', 'label'], ''],
          6, ['get', 'label'],
        ],
        'text-size': 11,
        'text-offset': [0, 1.4],
        'text-anchor': 'top',
        // Busier ports draw last => on top, so if two labels do overlap the important one is legible.
        'symbol-sort-key': ['get', 'atPort'],
      },
      paint: {
        'text-color': '#e8eaed',
        'text-halo-color': '#0b0d0f',
        'text-halo-width': 1.4,
      },
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
        'circle-radius': VESSEL_DOT_RADIUS as unknown as number,
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
        // Same reasoning as the dots — the arrows are the densest thing on the map at low zoom.
        'icon-size': ['interpolate', ['linear'], ['zoom'], 3, 0.45, 5, 0.65, 7, 0.9, 10, 1.1],
      },
      paint: {
        'icon-color': STATUS_MATCH as unknown as maplibregl.ExpressionSpecification,
        'icon-halo-color': '#0b0d0f',
        'icon-halo-width': 1,
      },
    });

    // Vessel name labels.
    //
    // Collision is ON and stays on — at the default view ~3,000 vessels are on screen and only ~160
    // names physically fit. The problem was never that they overlapped; it was that MapLibre broke
    // the tie by FEATURE ORDER, so the 160 that got named were arbitrary. Same ink, no information.
    // symbol-sort-key fixes which ones survive (see labelRankFor: stalled > slipping > big > moving).
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
        // Lower sorts first, and first means placed first means kept — so negate the rank.
        'symbol-sort-key': ['-', 0, ['get', 'labelRank']],
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
    if (this.pendingPorts) {
      this.setPorts(this.pendingPorts);
      this.pendingPorts = null;
    }
    // Re-apply the mode the panel already chose, in case it switched before the style was ready.
    this.setPortsVisible(this.portsVisible);
    if (this.pendingTripId != null) {
      void this.openTripById(this.pendingTripId);
      this.pendingTripId = null;
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
    this.voyageSeq++; // a click supersedes any in-flight deep-link (or older) voyage load
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
    if (detail.trip) setTripUrlParam(detail.trip.id); // make the current voyage view shareable
    this.bindShare();
  }

  /**
   * Open a voyage from a `?trip=<id>` deep-link — the shareable arrived-trip record (an open trip
   * shows its live leg). The vessel may no longer be on the live board, so the popup is built from
   * the trip record itself and anchored to the end of the track (or the map centre when sparse).
   */
  public async openTripById(id: number): Promise<void> {
    if (!Number.isFinite(id)) return;
    if (!this.ready) { this.pendingTripId = id; return; } // replayed from onLoad()
    const seq = ++this.voyageSeq; // token: a vessel click (or popup close) while we fetch supersedes us
    let detail: TripDetail;
    try {
      detail = await fetchTripById(id);
    } catch {
      return; // relay/proxy hiccup — leave the board as-is
    }
    if (seq !== this.voyageSeq) return; // the user selected something newer during the fetch — theirs wins
    if (!detail.found || !detail.trip) { setTripUrlParam(null); return; } // stale link (expired/unknown id)
    this.selectedMmsi = detail.trip.mmsi;
    const track = detail.track && detail.track.length ? detail.track : null;
    if (track) this.replay?.load(track); // frames the whole voyage (fit-to-track inside load)
    const last = track ? track[track.length - 1] : null;
    const at: [number, number] = last ? [last.lon, last.lat] : this.map.getCenter().toArray() as [number, number];
    this.popup.setLngLat(at).setHTML(tripHeaderHtml(detail) + voyageHtml(detail)).addTo(this.map);
    setTripUrlParam(detail.trip.id);
    this.bindShare();
  }

  /** Wire the popup's share button: copy the deep-link, flash confirmation. (Popup HTML is a string.) */
  private bindShare(): void {
    const btn = this.popup.getElement()?.querySelector<HTMLButtonElement>('.ferry-share-btn');
    btn?.addEventListener('click', () => {
      const url = new URL(window.location.href);
      url.searchParams.set('trip', btn.dataset.tripId || '');
      void navigator.clipboard?.writeText(url.toString()).then(() => {
        const label = btn.textContent;
        btn.textContent = '✓ Link copied';
        btn.disabled = true;
        setTimeout(() => { btn.textContent = label; btn.disabled = false; }, 1500);
      });
    }, { once: false });
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
  /** Replace the port congestion set (Ports mode). Safe before the style loads. */
  public setPorts(ports: PortStatus[]): void {
    this.pendingPorts = ports;
    if (!this.ready) return;
    const source = this.map.getSource(PORTS_SOURCE_ID) as maplibregl.GeoJSONSource | undefined;
    source?.setData(portsToGeoJSON(ports));
  }

  /**
   * Show/hide the port layer, and step the vessels back when it's on.
   *
   * The vessels aren't hidden in Ports mode — where the ships are is still the context that makes
   * a congested port meaningful — but they are dimmed and their labels dropped, so ~2,000 vessel
   * names don't compete with the 43 numbers the user switched modes to read.
   */
  public setPortsVisible(visible: boolean): void {
    this.portsVisible = visible;
    if (!this.ready) return;
    const visibility = visible ? 'visible' : 'none';
    for (const id of PORT_LAYERS) {
      if (this.map.getLayer(id)) this.map.setLayoutProperty(id, 'visibility', visibility);
    }
    if (this.map.getLayer('ferry-labels')) {
      this.map.setLayoutProperty('ferry-labels', 'visibility', visible ? 'none' : 'visible');
    }
    if (this.map.getLayer('ferry-dots')) {
      // The dark stroke is what gives each dot its weight; keep it only in Vessels mode.
      this.map.setPaintProperty('ferry-dots', 'circle-stroke-width', visible ? 0 : 1);
    }
    for (const id of ['ferry-dots', 'ferry-arrows']) {
      if (!this.map.getLayer(id)) continue;
      // 0.18, not the 0.35 first tried: there are ~2,000 vessel marks against 43 port discs, so
      // even at a third opacity the vessels still read as the subject. They need to become
      // texture — enough to show WHERE the traffic is, not enough to compete with a port.
      const prop = id === 'ferry-dots' ? 'circle-opacity' : 'icon-opacity';
      this.map.setPaintProperty(id, prop, visible ? 0.18 : 1);
      // Shrink the dots too — opacity alone leaves the same amount of ink on the map. Restoring
      // must put the ZOOM EXPRESSION back, not a flat number, or leaving Ports mode would silently
      // strip the zoom scaling for the rest of the session.
      if (id === 'ferry-dots') {
        this.map.setPaintProperty(id, 'circle-radius',
          visible ? 3 : (VESSEL_DOT_RADIUS as unknown as number));
      }
    }
  }

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

  /** Re-measure after the host was hidden/shown (MapLibre needs this to repaint at full size). */
  public resize(): void {
    this.map.resize();
  }

  public destroy(): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.map.remove();
  }
}
