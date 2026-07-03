// Voyage replay + waypoint inspector for the freight board (Phase C get_trip). Given a vessel's
// trip_points track, it renders: a SPEED-GRADED route line (colour = speed along the voyage), a bright
// "travelled" trail that grows as you play, hoverable waypoint dots (time · speed · ETA · slip at each
// point), and a glowing playhead marker that animates the crossing. A play/scrub control bar drives it.
// Everything is additive maplibre sources/layers + one DOM control bar mounted over the map; cleared on
// close / vessel change. All data comes from the points we already store — no new backend.

import maplibregl from 'maplibre-gl';
import { escapeHtml } from '@/utils/sanitize';
import type { TripPoint } from '@/services/logistics/trip-detail';

const ROUTE = 'vr-route';
const DONE = 'vr-done';
const WAYPOINTS = 'vr-waypoints';
const HEAD = 'vr-head';
const REPLAY_MS = 12_000; // a whole voyage plays in ~12s regardless of real duration

const EMPTY: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };
const toRad = (d: number): number => (d * Math.PI) / 180;
function haversineKm(a: [number, number], b: [number, number]): number {
  const dLat = toRad(b[1] - a[1]);
  const dLon = toRad(b[0] - a[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.sin(dLon / 2) ** 2 * Math.cos(toRad(a[1])) * Math.cos(toRad(b[1]));
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Speed → colour (kn): stopped grey · slow amber · cruising green · fast blue. */
function speedColor(kn: number | null): string {
  if (kn == null || kn < 1) return '#6b7280';
  if (kn < 8) return '#e0a032';
  if (kn < 14) return '#2fbf85';
  return '#4da3ff';
}
function hhmm(ms: number | null): string {
  if (ms == null) return '—';
  return new Date(ms).toISOString().slice(11, 16);
}

export class VoyageReplay {
  private map: maplibregl.Map;
  private bar: HTMLElement;
  private playBtn: HTMLButtonElement;
  private scrub: HTMLInputElement;
  private readout: HTMLElement;
  private hoverPopup: maplibregl.Popup;

  private pts: Array<{ lng: number; lat: number; ts: number; f: number; speedKn: number | null; eta: number | null; etaSlipMin: number | null }> = [];
  private t0 = 0;
  private t1 = 0;
  private progress = 0;   // 0..1 along voyage TIME
  private playing = false;
  private raf = 0;
  private active = false;

  constructor(map: maplibregl.Map) {
    this.map = map;
    // Sources (empty until a voyage loads). Route carries lineMetrics for the speed gradient.
    map.addSource(ROUTE, { type: 'geojson', lineMetrics: true, data: EMPTY });
    map.addSource(DONE, { type: 'geojson', data: EMPTY });
    map.addSource(WAYPOINTS, { type: 'geojson', data: EMPTY });
    map.addSource(HEAD, { type: 'geojson', data: EMPTY });
    // Speed-graded route (dim base), then the bright travelled trail on top.
    map.addLayer({ id: ROUTE, type: 'line', source: ROUTE, layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-width': 3, 'line-opacity': 0.55 } });
    map.addLayer({ id: DONE, type: 'line', source: DONE, layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#eaf2ff', 'line-width': 3.5, 'line-opacity': 0.95 } });
    map.addLayer({ id: WAYPOINTS, type: 'circle', source: WAYPOINTS, paint: { 'circle-radius': 3.5, 'circle-color': ['get', 'color'], 'circle-stroke-color': '#0b0d0f', 'circle-stroke-width': 1 } });
    map.addLayer({ id: `${HEAD}-glow`, type: 'circle', source: HEAD, paint: { 'circle-radius': 13, 'circle-color': '#4da3ff', 'circle-blur': 1, 'circle-opacity': 0.55 } });
    map.addLayer({ id: HEAD, type: 'circle', source: HEAD, paint: { 'circle-radius': 5.5, 'circle-color': '#eaf2ff', 'circle-stroke-color': '#4da3ff', 'circle-stroke-width': 2 } });

    // Waypoint hover inspector.
    this.hoverPopup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 10, className: 'vr-hover' });
    map.on('mouseenter', WAYPOINTS, (e) => this.onWaypointHover(e));
    map.on('mouseleave', WAYPOINTS, () => { map.getCanvas().style.cursor = ''; this.hoverPopup.remove(); });

    // Control bar (mounted over the map).
    this.bar = document.createElement('div');
    this.bar.className = 'voyage-replay';
    this.bar.hidden = true;
    this.bar.innerHTML =
      '<button class="vr-play" type="button" aria-label="Play voyage">▶</button>'
      + '<input class="vr-scrub" type="range" min="0" max="1000" value="0" aria-label="Scrub voyage">'
      + '<span class="vr-readout">—</span>';
    map.getContainer().appendChild(this.bar);
    this.playBtn = this.bar.querySelector('.vr-play') as HTMLButtonElement;
    this.scrub = this.bar.querySelector('.vr-scrub') as HTMLInputElement;
    this.readout = this.bar.querySelector('.vr-readout') as HTMLElement;
    this.playBtn.addEventListener('click', () => this.togglePlay());
    this.scrub.addEventListener('input', () => { this.pause(); this.setProgress(Number(this.scrub.value) / 1000); });
  }

  /** Load a track: build the speed-graded route + waypoints, fit the map, reset the scrubber. */
  load(track: TripPoint[]): void {
    const valid = track.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon) && Number.isFinite(p.ts));
    if (valid.length < 2) { this.clear(); return; }
    valid.sort((a, b) => a.ts - b.ts);
    // Cumulative distance fractions for the gradient (line-progress is distance-based).
    const coords: Array<[number, number]> = valid.map((p) => [p.lon, p.lat]);
    const cum: number[] = [0];
    for (let i = 1; i < coords.length; i++) cum[i] = (cum[i - 1] ?? 0) + haversineKm(coords[i - 1]!, coords[i]!);
    const total = cum[cum.length - 1] || 1;
    this.pts = valid.map((p, i) => ({ lng: p.lon, lat: p.lat, ts: p.ts, f: (cum[i] ?? 0) / total, speedKn: p.speedKn, eta: p.eta, etaSlipMin: p.etaSlipMin }));
    this.t0 = this.pts[0]!.ts;
    this.t1 = this.pts[this.pts.length - 1]!.ts;

    // Speed gradient: strictly-increasing line-progress stops → speed colour.
    const stops: Array<number | string> = [];
    let last = -1;
    for (const p of this.pts) {
      const f = Math.min(1, Math.max(0, p.f));
      if (f <= last) continue;
      last = f; stops.push(f, speedColor(p.speedKn));
    }
    const gradient = stops.length >= 4
      ? (['interpolate', ['linear'], ['line-progress'], ...stops] as unknown as maplibregl.ExpressionSpecification)
      : speedColor(this.pts[0]!.speedKn);
    this.map.setPaintProperty(ROUTE, 'line-gradient', gradient as never);

    this.setData(ROUTE, { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords } }] });
    this.setData(WAYPOINTS, { type: 'FeatureCollection', features: this.pts.map((p) => ({ type: 'Feature', properties: { color: speedColor(p.speedKn), ts: p.ts, speedKn: p.speedKn, eta: p.eta, etaSlipMin: p.etaSlipMin }, geometry: { type: 'Point', coordinates: [p.lng, p.lat] } })) });

    // Frame the whole voyage.
    const b = new maplibregl.LngLatBounds(coords[0]!, coords[0]!);
    for (const c of coords) b.extend(c);
    this.map.fitBounds(b, { padding: 70, maxZoom: 11, duration: 700 });

    this.active = true;
    this.bar.hidden = false;
    this.progress = 0;
    this.pause();          // paused, ▶, static glow
    this.setProgress(0);   // playhead at the start
  }

  /** Tear down the current voyage (keeps sources/layers, just empties them + hides the bar). */
  clear(): void {
    this.active = false;
    this.playing = false;
    this.bar.hidden = true;
    this.hoverPopup.remove();
    if (this.raf) { cancelAnimationFrame(this.raf); this.raf = 0; }
    for (const id of [ROUTE, DONE, WAYPOINTS, HEAD]) this.setData(id, EMPTY);
  }

  private setData(id: string, data: GeoJSON.FeatureCollection): void {
    (this.map.getSource(id) as maplibregl.GeoJSONSource | undefined)?.setData(data);
  }

  private togglePlay(): void { this.playing ? this.pause() : this.play(); }
  private play(): void {
    if (!this.active) return;
    if (this.progress >= 1) this.progress = 0; // replay from the start
    this.playing = true; this.playBtn.textContent = '⏸'; this.lastTs = 0;
    if (!this.raf) this.raf = requestAnimationFrame(this.tick); // rAF runs ONLY while playing
  }
  private pause(): void {
    this.playing = false; this.playBtn.textContent = '▶';
    if (this.raf) { cancelAnimationFrame(this.raf); this.raf = 0; }
    this.map.setPaintProperty(`${HEAD}-glow`, 'circle-radius', 13); // static glow when idle
  }

  private lastTs = 0;
  private tick = (now: number): void => {
    if (!this.active || !this.playing) { this.raf = 0; return; }
    if (this.lastTs) this.progress = Math.min(1, this.progress + (now - this.lastTs) / REPLAY_MS);
    this.lastTs = now;
    this.setProgress(this.progress);
    this.map.setPaintProperty(`${HEAD}-glow`, 'circle-radius', 11 + 3 * (0.5 + 0.5 * Math.sin(now / 380))); // pulse
    if (this.progress >= 1) { this.pause(); return; } // reached the end — stop the loop
    this.raf = requestAnimationFrame(this.tick);
  };

  /** Position the playhead + grow the trail at time-progress p (0..1); update the readout + scrubber. */
  private setProgress(p: number): void {
    if (!this.pts.length) return;
    const t = lerp(this.t0, this.t1, p);
    let i = 0;
    while (i < this.pts.length - 1 && this.pts[i + 1]!.ts <= t) i++;
    const a = this.pts[i]!;
    const b = this.pts[Math.min(i + 1, this.pts.length - 1)]!;
    const seg = b.ts > a.ts ? (t - a.ts) / (b.ts - a.ts) : 0;
    const head: [number, number] = [lerp(a.lng, b.lng, seg), lerp(a.lat, b.lat, seg)];

    const done: Array<[number, number]> = this.pts.slice(0, i + 1).map((q) => [q.lng, q.lat]);
    done.push(head);
    this.setData(DONE, done.length >= 2 ? { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: done } }] } : EMPTY);
    this.setData(HEAD, { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: head } }] });

    const slip = a.etaSlipMin != null ? ` (${a.etaSlipMin >= 0 ? '+' : ''}${Math.round(a.etaSlipMin)}m)` : '';
    this.readout.textContent = `${hhmm(t)}Z · ${a.speedKn != null ? Math.round(a.speedKn) + ' kn' : '—'} · ETA ${hhmm(a.eta)}${a.eta != null ? 'Z' : ''}${slip}`;
    this.scrub.value = String(Math.round(p * 1000));
  }

  private onWaypointHover(e: maplibregl.MapLayerMouseEvent): void {
    const f = e.features?.[0];
    if (!f) return;
    this.map.getCanvas().style.cursor = 'pointer';
    const pr = f.properties as { ts?: number; speedKn?: number | null; eta?: number | null; etaSlipMin?: number | null };
    const slip = pr.etaSlipMin != null ? ` (${pr.etaSlipMin >= 0 ? '+' : ''}${Math.round(pr.etaSlipMin)}m)` : '';
    const html = `<div class="vr-hover-row"><b>${hhmm(pr.ts ?? null)}Z</b> · ${pr.speedKn != null ? Math.round(pr.speedKn) + ' kn' : '—'}</div>`
      + `<div class="vr-hover-row vr-hover-dim">ETA ${hhmm(pr.eta ?? null)}${pr.eta != null ? 'Z' : ''}${escapeHtml(slip)}</div>`;
    this.hoverPopup.setLngLat((f.geometry as GeoJSON.Point).coordinates as [number, number]).setHTML(html).addTo(this.map);
  }
}
