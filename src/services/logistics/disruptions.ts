// Freight disruptions for the board, from the relay's merged /ais/disruptions feed
// (proxied through /api/ais-disruptions on the web, direct to the relay in local dev).
//
// This is the visual surface for the layered disruption sources: scheduled strikes (M3,
// official calendars), water levels (M5 — Rhine gauge, Venice MOSE, Panama advisories), and
// the market-implied chokepoint signal (M6 — Hormuz). The relay does the merging/hedging; this
// just types the rows and buckets them by actionability for display. The proxy passes keyless
// from a trusted browser origin (the paywall gates PROGRAMMATIC access, not the first-party board).

import { relayFetch } from './relay-fetch';

const DISRUPTIONS_PROXY_URL = '/api/ais-disruptions';
const LOCAL_RELAY_DISRUPTIONS_URL = 'http://localhost:3004/ais/disruptions';

export type DisruptionKind =
  | 'strike_scheduled'
  | 'strike_report'
  | 'waterway_low_water'
  | 'water_closure'
  | 'draft_restriction'
  | 'chokepoint_disruption';

export interface DisruptionEvent {
  id: string;
  kind: DisruptionKind;
  summary: string;
  source: string;
  confidence: number;
  /** Epoch ms for officially-dated events (scheduled strikes); null for signals/reports. */
  startsAt: number | null;
  country: string | null;
  url: string | null;
}

// Display buckets, most actionable first. 'official' = dated/announced facts you can plan around;
// 'signals' = live gauge/market intelligence (the differentiated layer); 'reports' = hedged news.
export type DisruptionBucket = 'official' | 'signals' | 'reports';

const KIND_BUCKET: Record<DisruptionKind, DisruptionBucket> = {
  strike_scheduled: 'official',
  water_closure: 'official',
  draft_restriction: 'official',
  waterway_low_water: 'signals',
  chokepoint_disruption: 'signals',
  strike_report: 'reports',
};

export function bucketOf(kind: DisruptionKind): DisruptionBucket {
  return KIND_BUCKET[kind] ?? 'reports';
}

const KNOWN_KINDS = new Set<string>(Object.keys(KIND_BUCKET));

function toDisruption(row: unknown): DisruptionEvent | null {
  if (!row || typeof row !== 'object') return null;
  const r = row as Record<string, unknown>;
  if (typeof r.id !== 'string' || typeof r.kind !== 'string' || !KNOWN_KINDS.has(r.kind)) return null;
  if (typeof r.summary !== 'string' || !r.summary) return null;
  const startsAt = typeof r.startsAt === 'number' && Number.isFinite(r.startsAt) ? r.startsAt : null;
  return {
    id: r.id,
    kind: r.kind as DisruptionKind,
    summary: r.summary,
    source: typeof r.source === 'string' ? r.source : 'unknown',
    confidence: typeof r.confidence === 'number' ? r.confidence : 0,
    startsAt,
    country: typeof r.country === 'string' ? r.country : null,
    url: typeof r.url === 'string' ? r.url : null,
  };
}

export function parseDisruptions(json: unknown): DisruptionEvent[] {
  const rows: unknown = (json as { events?: unknown })?.events;
  if (!Array.isArray(rows)) return [];
  const out: DisruptionEvent[] = [];
  for (const row of rows) {
    const e = toDisruption(row);
    if (e) out.push(e);
  }
  return out;
}

/** Fetch the merged freight disruption feed, with a local-relay fallback in dev. */
export function getDisruptions(): Promise<DisruptionEvent[]> {
  return relayFetch(DISRUPTIONS_PROXY_URL, LOCAL_RELAY_DISRUPTIONS_URL, parseDisruptions);
}
