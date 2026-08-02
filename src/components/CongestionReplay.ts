import type maplibregl from 'maplibre-gl';
import type { PortSeries } from '@/services/logistics/port-series';

// Play the whole window in roughly this long, whatever the frame count — 48h at 15min is 193
// frames, so ~125ms each. Slow enough to read a port changing, fast enough to sit through.
const REPLAY_MS = 24_000;

/**
 * Scrubber for the port-congestion replay.
 *
 * Deliberately NOT built on VoyageReplay's transport despite the similar-looking bar. That one
 * interpolates a position CONTINUOUSLY along a path (progress 0..1, lerped between track points);
 * this steps DISCRETE frames on a regular grid, where frame N is a stored observation and there is
 * nothing meaningful between N and N+1. Sharing a base class would mean one of them lying about
 * what its progress value represents.
 *
 * Owns only the control bar and the frame cursor. What a frame DRAWS is the map's business — this
 * calls back with an index.
 */
export class CongestionReplay {
  private bar: HTMLElement;
  private playBtn: HTMLButtonElement;
  private scrub: HTMLInputElement;
  private readout: HTMLElement;
  private onFrame: (frame: number) => void;

  private series: PortSeries | null = null;
  private frame = 0;
  private playing = false;
  private raf = 0;
  private lastTs = 0;
  /** Fractional cursor so playback speed is independent of frame count. */
  private cursor = 0;

  constructor(map: maplibregl.Map, onFrame: (frame: number) => void) {
    this.onFrame = onFrame;
    this.bar = document.createElement('div');
    this.bar.className = 'congestion-replay';
    this.bar.hidden = true;
    this.bar.innerHTML =
      '<button class="cr-play" type="button" aria-label="Play congestion replay">▶</button>'
      + '<input class="cr-scrub" type="range" min="0" max="0" value="0" aria-label="Scrub congestion history">'
      + '<span class="cr-readout">—</span>';
    map.getContainer().appendChild(this.bar);
    this.playBtn = this.bar.querySelector('.cr-play') as HTMLButtonElement;
    this.scrub = this.bar.querySelector('.cr-scrub') as HTMLInputElement;
    this.readout = this.bar.querySelector('.cr-readout') as HTMLElement;

    this.playBtn.addEventListener('click', () => (this.playing ? this.pause() : this.play()));
    this.scrub.addEventListener('input', () => {
      this.pause();
      this.setFrame(Number(this.scrub.value));
    });
  }

  /** True while a series is loaded and the bar is showing. */
  get active(): boolean {
    return !!this.series && !this.bar.hidden;
  }

  /**
   * Load a series and show the bar, parked on the MOST RECENT frame.
   *
   * Starting at the end rather than the beginning means switching the replay on does not jump the
   * map backwards in time — the first thing shown matches what was already on screen, and the user
   * scrubs back from there.
   */
  load(series: PortSeries): void {
    if (!series.tickCount) { this.clear(); return; }
    this.series = series;
    this.scrub.max = String(series.tickCount - 1);
    this.bar.hidden = false;
    this.setFrame(series.tickCount - 1);
  }

  /** Hide the bar and stop playback. Does not restore live data — the caller owns that. */
  clear(): void {
    this.pause();
    this.series = null;
    this.bar.hidden = true;
  }

  destroy(): void {
    this.clear();
    this.bar.remove();
  }

  private play(): void {
    if (!this.series) return;
    // Replaying from the end would finish instantly; rewind first.
    if (this.frame >= this.series.tickCount - 1) this.setFrame(0);
    this.playing = true;
    this.playBtn.textContent = '⏸';
    this.lastTs = 0;
    if (!this.raf) this.raf = requestAnimationFrame(this.tick);
  }

  private pause(): void {
    this.playing = false;
    this.playBtn.textContent = '▶';
    if (this.raf) { cancelAnimationFrame(this.raf); this.raf = 0; }
  }

  private tick = (now: number): void => {
    if (!this.playing || !this.series) { this.raf = 0; return; }
    const frames = this.series.tickCount;
    if (this.lastTs) this.cursor += ((now - this.lastTs) / REPLAY_MS) * frames;
    this.lastTs = now;
    const next = Math.min(frames - 1, Math.floor(this.cursor));
    if (next !== this.frame) this.setFrame(next, true);
    if (this.frame >= frames - 1) { this.pause(); return; }
    this.raf = requestAnimationFrame(this.tick);
  };

  /** Move to a frame, update the bar, and tell the caller to redraw. */
  private setFrame(frame: number, fromTick = false): void {
    const s = this.series;
    if (!s) return;
    this.frame = Math.max(0, Math.min(s.tickCount - 1, Math.round(frame)));
    if (!fromTick) this.cursor = this.frame;
    this.scrub.value = String(this.frame);
    this.readout.textContent = this.readoutFor(s, this.frame);
    this.onFrame(this.frame);
  }

  private readoutFor(s: PortSeries, frame: number): string {
    const ts = s.ts[frame];
    if (ts == null) return '—';
    const d = new Date(ts);
    const hhmm = `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
    const agoMin = Math.max(0, Math.round((Date.now() - ts) / 60_000));
    // The newest frame is "now" only within one grid step; past that, say how far back it is.
    const ago = agoMin < s.stepMin ? 'now'
      : agoMin < 60 ? `${agoMin}m ago`
        : `${Math.round(agoMin / 60)}h ago`;
    return `${hhmm}Z · ${ago}`;
  }
}
