// Columnar per-port congestion series from the relay's /ais/port-series endpoint (proxied through
// /api/ais-port-series on the web, direct to the relay in local dev). Feeds the freight board's
// congestion REPLAY — see PortSeries below for why this is not /ais/port-history.

import { relayFetch } from './relay-fetch';

const PORT_SERIES_PROXY_URL = '/api/ais-port-series';
const LOCAL_RELAY_PORT_SERIES_URL = 'http://localhost:3004/ais/port-series';

/** Fields the series can carry. `atBerth` is what congestion is derived from. */
export type PortSeriesField = 'atBerth' | 'atPort' | 'atAnchor' | 'inbound';

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
  ports: Record<string, Partial<Record<PortSeriesField, (number | null)[]>>>;
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

const FIELDS: PortSeriesField[] = ['atBerth', 'atPort', 'atAnchor', 'inbound'];

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
    const series: Partial<Record<PortSeriesField, (number | null)[]>> = {};
    for (const f of fields) {
      const arr = numberArray((raw as Record<string, unknown>)[f], ts.length);
      if (arr) series[f] = arr;
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
  field: PortSeriesField = 'atBerth',
): number | null {
  const arr = series.ports[portId]?.[field];
  if (!arr || frame < 0 || frame >= arr.length) return null;
  return arr[frame] ?? null;
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
  field: PortSeriesField = 'atBerth',
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
