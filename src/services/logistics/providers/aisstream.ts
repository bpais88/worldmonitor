// Free vessel data provider — backed by aisstream.io via the Railway relay's
// /ais/vessels endpoint (proxied through /api/ais-vessels on the web).

import type { VesselDataProvider, VesselQuery, LiveVessel } from './types';
import { shipTypeCategory, type ShipCategory } from '../classify';

const VESSELS_PROXY_URL = '/api/ais-vessels';
const LOCAL_RELAY_VESSELS_URL = 'http://localhost:3004/ais/vessels';

/** A candidate explanation for a delay (weather, news, ...). */
export interface RawRelayReason {
  source?: string;
  kind?: string;
  summary?: string;
  confidence?: number;
  url?: string;
  detail?: string;
}

/** Delay status computed by the relay (Method B — ETA drift). */
export interface RawRelayDelay {
  slipping?: boolean;
  stalled?: boolean;
  etaGrowthMin?: number;
  windowMin?: number;
  samples?: number;
  reasons?: RawRelayReason[];
}

/** Raw vessel shape as returned by the relay /ais/vessels endpoint. */
export interface RawRelayVessel {
  mmsi: string;
  name?: string;
  lat: number;
  lon: number;
  speed?: number;
  course?: number;
  heading?: number;
  navStatus?: number;
  shipType?: number;
  category?: string;
  imo?: string;
  destination?: string;
  callSign?: string;
  draught?: number;
  length?: number;
  beam?: number;
  etaAis?: string;
  delay?: RawRelayDelay;
  timestamp?: number;
}

const VALID_CATEGORIES: ReadonlySet<ShipCategory> = new Set([
  'passenger', 'cargo', 'tanker', 'hsc', 'other',
]);

function normalizeCategory(raw: string | undefined, shipType: number | undefined): ShipCategory {
  if (raw && VALID_CATEGORIES.has(raw as ShipCategory)) return raw as ShipCategory;
  return shipTypeCategory(shipType);
}

/** Map a raw relay vessel to a LiveVessel, or null if it lacks a usable position. */
export function toLiveVessel(raw: RawRelayVessel): LiveVessel | null {
  if (!raw || !raw.mmsi || !Number.isFinite(raw.lat) || !Number.isFinite(raw.lon)) return null;
  const shipType = Number.isFinite(raw.shipType) ? raw.shipType : undefined;
  return {
    mmsi: String(raw.mmsi),
    name: raw.name || '',
    lat: raw.lat,
    lon: raw.lon,
    speedKnots: Number.isFinite(raw.speed) ? raw.speed : undefined,
    courseDeg: Number.isFinite(raw.course) ? raw.course : undefined,
    headingDeg: Number.isFinite(raw.heading) ? raw.heading : undefined,
    shipType,
    imo: raw.imo || undefined,
    destination: raw.destination || undefined,
    callSign: raw.callSign || undefined,
    draughtMeters: Number.isFinite(raw.draught) && (raw.draught as number) > 0 ? raw.draught : undefined,
    lengthMeters: Number.isFinite(raw.length) && (raw.length as number) > 0 ? raw.length : undefined,
    beamMeters: Number.isFinite(raw.beam) && (raw.beam as number) > 0 ? raw.beam : undefined,
    etaAis: raw.etaAis || undefined,
    category: normalizeCategory(raw.category, shipType),
    navStatus: Number.isFinite(raw.navStatus) ? raw.navStatus : undefined,
    delay: raw.delay && (raw.delay.slipping || raw.delay.stalled) ? {
      slipping: !!raw.delay.slipping,
      stalled: !!raw.delay.stalled,
      etaGrowthMin: Number.isFinite(raw.delay.etaGrowthMin) ? raw.delay.etaGrowthMin : undefined,
      windowMin: Number.isFinite(raw.delay.windowMin) ? raw.delay.windowMin : undefined,
      samples: Number.isFinite(raw.delay.samples) ? raw.delay.samples : undefined,
      reasons: Array.isArray(raw.delay.reasons)
        ? raw.delay.reasons
            .filter((r) => r && typeof r.summary === 'string' && r.summary.length > 0)
            .map((r) => ({
              source: String(r.source ?? ''),
              kind: String(r.kind ?? ''),
              summary: r.summary as string,
              confidence: Number.isFinite(r.confidence) ? (r.confidence as number) : 0,
              url: r.url || undefined,
              detail: r.detail || undefined,
            }))
        : undefined,
    } : undefined,
    timestamp: Number.isFinite(raw.timestamp) ? (raw.timestamp as number) : Date.now(),
  };
}

/** Build the query string for the /ais/vessels endpoint from a VesselQuery. */
export function buildVesselsQueryString(query: VesselQuery): string {
  const params = new URLSearchParams();
  if (query.bbox) params.set('bbox', query.bbox.join(','));
  if (query.categories && query.categories.length > 0) params.set('types', query.categories.join(','));
  if (query.limit && Number.isFinite(query.limit)) params.set('limit', String(query.limit));
  const s = params.toString();
  return s ? `?${s}` : '';
}

export class AisStreamProvider implements VesselDataProvider {
  readonly id = 'aisstream';

  constructor(private readonly baseUrl: string = VESSELS_PROXY_URL) {}

  async getVesselsInBounds(query: VesselQuery): Promise<LiveVessel[]> {
    const qs = buildVesselsQueryString(query);
    try {
      return await this.fetchVessels(this.baseUrl, qs);
    } catch (err) {
      // Local dev fallback: hit the relay directly when the /api proxy isn't
      // running (e.g. plain `vite dev` without Vercel functions).
      if (
        typeof window !== 'undefined' &&
        window.location.hostname === 'localhost' &&
        this.baseUrl !== LOCAL_RELAY_VESSELS_URL
      ) {
        return this.fetchVessels(LOCAL_RELAY_VESSELS_URL, qs);
      }
      throw err;
    }
  }

  private async fetchVessels(base: string, qs: string): Promise<LiveVessel[]> {
    const res = await fetch(`${base}${qs}`, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`ais-vessels request failed: ${res.status}`);
    const data = await res.json();
    const rows: unknown = (data as { vessels?: unknown })?.vessels;
    if (!Array.isArray(rows)) return [];
    const out: LiveVessel[] = [];
    for (const row of rows) {
      const v = toLiveVessel(row as RawRelayVessel);
      if (v) out.push(v);
    }
    return out;
  }
}

/** Default singleton used by the app. */
export const aisStreamProvider = new AisStreamProvider();
