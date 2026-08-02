// Columnar per-port congestion series from the relay's /ais/port-series endpoint (proxied through
// /api/ais-port-series on the web, direct to the relay in local dev). Feeds the freight board's
// congestion REPLAY — see PortSeries below for why this is not /ais/port-history.

import { relayFetch } from './relay-fetch';

const PORT_SERIES_PROXY_URL = '/api/ais-port-series';
const LOCAL_RELAY_PORT_SERIES_URL = 'http://localhost:3004/ais/port-series';

/** Count fields the series can carry. `atBerth` is what congestion is derived from. */
export type PortSeriesCountField = 'atBerth' | 'atPort' | 'atAnchor' | 'inbound';
/** The stored ABSOLUTE congestion label. Not congestionRel — see the relay's queryPortSeries. */
export type PortSeriesTextField = 'level';
export type PortSeriesField = PortSeriesCountField | PortSeriesTextField;

/** Congestion labels the `level` series can hold — the same set the live map paints. */
export type PortSeriesLevel = 'clear' | 'busy' | 'congested';

/** One port's columns. Count fields are numeric; `level` is the congestion label. */
export type PortSeriesColumns =
  & Partial<Record<PortSeriesCountField, (number | null)[]>>
  & { level?: (PortSeriesLevel | null)[] };

export interface PortSeries {
  /** Shared, regularly-spaced time axis (ms). Every port array is index-aligned to this. */
  ts: number[];
  /**
   * portId → field → values, index-aligned to {@link ts}.
   *
   * A `null` means NO FRESH READING for that port at that frame. It is NOT zero, and must never be
   * drawn as an empty port: the relay excludes rows whose coverage was not ok (they record zeros
   * that would animate as the port emptying) and it only carries a reading forward for a bounded
   * window before giving up. Render null as unknown.
   */
  ports: Record<string, PortSeriesColumns>;
  fields: PortSeriesField[];
  hours: number;
  /** Grid spacing in minutes — the relay resamples onto a regular axis. */
  stepMin: number;
  tickCount: number;
  portCount: number;
  generatedAt: number;
  /** False when the relay has no database configured — an empty series, not an error. */
  db: boolean;
}

const COUNT_FIELDS: PortSeriesCountField[] = ['atBerth', 'atPort', 'atAnchor', 'inbound'];
const FIELDS: PortSeriesField[] = [...COUNT_FIELDS, 'level'];
const LEVELS: PortSeriesLevel[] = ['clear', 'busy', 'congested'];

function isCountField(f: PortSeriesField): f is PortSeriesCountField {
  return (COUNT_FIELDS as PortSeriesField[]).includes(f);
}

function numberArray(v: unknown, length: number): (number | null)[] | undefined {
  if (!Array.isArray(v)) return undefined;
  // Trust the length from `ts`, not the row: a short/long array would silently desync playback.
  const out: (number | null)[] = new Array(length).fill(null);
  for (let i = 0; i < Math.min(v.length, length); i++) {
    const n = Number(v[i]);
    out[i] = v[i] == null || !Number.isFinite(n) ? null : n;
  }
  return out;
}

function levelArray(v: unknown, length: number): (PortSeriesLevel | null)[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: (PortSeriesLevel | null)[] = new Array(length).fill(null);
  for (let i = 0; i < Math.min(v.length, length); i++) {
    const s = v[i];
    // An unrecognised label becomes null (unknown) rather than being passed through — the map
    // paints by exact match and would fall through to the grey "unknown" colour anyway.
    out[i] = LEVELS.includes(s as PortSeriesLevel) ? (s as PortSeriesLevel) : null;
  }
  return out;
}

/** Exported for tests — the wire shape is the relay's, so parsing is worth pinning. */
export function parsePortSeries(json: unknown): PortSeries {
  const j = (json ?? {}) as Record<string, unknown>;
  const ts = Array.isArray(j.ts) ? j.ts.map(Number).filter(Number.isFinite) : [];
  const fields = (Array.isArray(j.fields) ? j.fields : [])
    .filter((f): f is PortSeriesField => FIELDS.includes(f as PortSeriesField));
  const ports: PortSeries['ports'] = {};
  const rawPorts = (j.ports ?? {}) as Record<string, unknown>;
  for (const [portId, raw] of Object.entries(rawPorts)) {
    if (!raw || typeof raw !== 'object') continue;
    const series: PortSeriesColumns = {};
    for (const f of fields) {
      const col = (raw as Record<string, unknown>)[f];
      if (isCountField(f)) {
        const arr = numberArray(col, ts.length);
        if (arr) series[f] = arr;
      } else {
        const arr = levelArray(col, ts.length);
        if (arr) series.level = arr;
      }
    }
    if (Object.keys(series).length) ports[portId] = series;
  }
  return {
    ts,
    ports,
    fields,
    hours: Number(j.hours) || 0,
    stepMin: Number(j.stepMin) || 0,
    tickCount: ts.length,
    portCount: Object.keys(ports).length,
    generatedAt: Number(j.generatedAt) || Date.now(),
    db: j.db !== false,
  };
}

export interface PortSeriesQuery {
  hours?: number;
  ports?: string[];
  fields?: PortSeriesField[];
  stepMin?: number;
}

/** Build the query string for /ais/port-series. Exported for tests. */
export function buildPortSeriesQuery(q: PortSeriesQuery = {}): string {
  const params = new URLSearchParams();
  if (Number.isFinite(q.hours)) params.set('hours', String(q.hours));
  if (q.ports && q.ports.length) params.set('ports', q.ports.join(','));
  if (q.fields && q.fields.length) params.set('fields', q.fields.join(','));
  if (Number.isFinite(q.stepMin)) params.set('stepMin', String(q.stepMin));
  const s = params.toString();
  return s ? `?${s}` : '';
}

/** Fetch the per-port congestion series, with a local-relay fallback in dev. */
export function getPortSeries(query: PortSeriesQuery = {}): Promise<PortSeries> {
  const qs = buildPortSeriesQuery(query);
  return relayFetch(PORT_SERIES_PROXY_URL + qs, LOCAL_RELAY_PORT_SERIES_URL + qs, parsePortSeries);
}

/**
 * The value for a port/field at a frame, or null.
 *
 * Playback indexes by frame constantly, so this keeps the null-vs-zero rule (see {@link PortSeries})
 * in one place rather than at every call site.
 */
export function valueAt(
  series: PortSeries,
  portId: string,
  frame: number,
  field: PortSeriesCountField = 'atBerth',
): number | null {
  const arr = series.ports[portId]?.[field];
  if (!arr || frame < 0 || frame >= arr.length) return null;
  return arr[frame] ?? null;
}

/** The congestion label for a port at a frame, or null when there is no fresh reading. */
export function levelAt(series: PortSeries, portId: string, frame: number): PortSeriesLevel | null {
  const arr = series.ports[portId]?.level;
  if (!arr || frame < 0 || frame >= arr.length) return null;
  return arr[frame] ?? null;
}

/**
 * Project one replay frame onto the live PortStatus shape.
 *
 * The series carries only what VARIES with time; port identity (name, lat/lon) is not in it. So the
 * live port list supplies identity and the frame overrides the counts and the level. The payoff is
 * that the replay reuses the whole live encoding — disc radius, fill colour, anchor queue ring,
 * labels — instead of defining a second, divergent one.
 *
 * A port with no fresh reading at this frame comes back with coverageOk:false, which the map
 * already draws hollow ("there is a port here, we cannot currently see it"). That is the honest
 * rendering of a gap, and specifically NOT a port that is empty and clear.
 */
export function framePorts<T extends PortStatusLike>(
  livePorts: readonly T[],
  series: PortSeries,
  frame: number,
): T[] {
  return livePorts.map((p) => {
    const cols = series.ports[p.portId];
    const level = levelAt(series, p.portId, frame);
    const atPort = valueAt(series, p.portId, frame, 'atPort');
    // One reading covers the whole row, so `level` alone decides whether this frame is observed.
    if (!cols || level == null) {
      return { ...p, atPort: 0, atBerth: 0, atAnchor: 0, coverageOk: false, congestion: null, congestionRel: null };
    }
    return {
      ...p,
      atPort: atPort ?? 0,
      atBerth: valueAt(series, p.portId, frame, 'atBerth') ?? 0,
      atAnchor: valueAt(series, p.portId, frame, 'atAnchor') ?? 0,
      coverageOk: true,
      // The stored label is ABSOLUTE congestion. congestionRel is derived live against a dow×hour
      // baseline and is not stored per snapshot, so it must be cleared — leaving a live relative
      // value on a historical frame would paint the past with the present's colour.
      congestion: level,
      congestionRel: null,
    };
  });
}

/**
 * The subset of PortStatus the replay reads and overrides.
 *
 * Structural, not an import of PortStatus, so this module stays free of the live port-status types
 * — and nullable to match them: PortStatus carries `congestion: PortCongestion | null`, and
 * levelFor() reads it with `??`, so null and undefined behave identically there.
 */
export interface PortStatusLike {
  portId: string;
  atPort?: number;
  atBerth?: number;
  atAnchor?: number;
  coverageOk?: boolean;
  congestion?: string | null;
  congestionRel?: string | null;
}

/**
 * A port's own min/max across the window, ignoring null frames.
 *
 * The replay scales each port against ITSELF, not against other ports: raw counts are not
 * comparable between ports (Rotterdam always outnumbers Savona — that is what congestionRel exists
 * to fix), but across a single port's own timeline the size difference is constant and cancels out.
 * Returns null when the port has no readings at all in the window.
 */
export function rangeFor(
  series: PortSeries,
  portId: string,
  field: PortSeriesCountField = 'atBerth',
): { min: number; max: number } | null {
  const arr = series.ports[portId]?.[field];
  if (!arr) return null;
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const v of arr) {
    if (v == null) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return Number.isFinite(min) ? { min, max } : null;
}
