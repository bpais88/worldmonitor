// One freight voyage (trip) + its track, from the relay's /ais/trip endpoint (proxied through
// /api/ais-trip on the web, direct to the relay in local dev). Phase C get_trip — the click-to-voyage
// data layer. The relay computes the sufficiency gate; `notes` carries per-field caveats the UI renders
// as chips (never a bare 0).

import { relayFetch } from './relay-fetch';

const TRIP_PROXY_URL = '/api/ais-trip';
const LOCAL_RELAY_TRIP_URL = 'http://localhost:3004/ais/trip';

export interface TripPoint {
  ts: number;
  lat: number;
  lon: number;
  speedKn: number | null;
  course: number | null;
  eta: number | null;
  etaSlipMin: number | null;
}

export interface Trip {
  id: number;
  mmsi: string;
  vesselName: string | null;
  imo: string | null;
  operator: string | null;
  category: string | null;
  status: 'open' | 'arrived' | 'abandoned';
  originPortId: string | null;
  origin: string | null;
  destPortId: string | null;
  dest: string | null;
  openedAt: number | null;
  departedAt: number | null;
  arrivedAt: number | null;
  durationMin: number | null;
  distanceKm: number | null;
  avgSpeedKn: number | null;
  destDwellMin: number | null;
  departureEta: number | null;
  maxEtaSlipMin: number | null;
  stalled: boolean;
  onTime: { slipMin: number | null; toleranceMin: number } | null;
}

export interface TripDetail {
  found: boolean;
  trip: Trip | null;
  /** The route track — present only when >= 5 points were captured; else null with a `notes.track`. */
  track: TripPoint[] | null;
  pointCount: number;
  densityPerHr: number | null;
  /** field → caveat note (suppressed/annotated fields), rendered as a chip. Never a bare 0. */
  notes: Record<string, string>;
}

const EMPTY: TripDetail = { found: false, trip: null, track: null, pointCount: 0, densityPerHr: null, notes: {} };

/** Parse the relay's /ais/trip payload; pure (unit-testable). */
export function parseTripDetail(json: unknown): TripDetail {
  const j = (json ?? {}) as Record<string, unknown>;
  if (!j.found || !j.trip) return EMPTY;
  return {
    found: true,
    trip: j.trip as Trip,
    track: Array.isArray(j.track) ? (j.track as TripPoint[]) : null,
    pointCount: Number(j.pointCount) || 0,
    densityPerHr: j.densityPerHr == null ? null : Number(j.densityPerHr),
    notes: j.notes && typeof j.notes === 'object' ? (j.notes as Record<string, string>) : {},
  };
}

/** Fetch a vessel's latest/open trip by mmsi (the freight board's click-to-voyage). */
export function fetchTripByMmsi(mmsi: string): Promise<TripDetail> {
  const qs = `?mmsi=${encodeURIComponent(mmsi)}`;
  return relayFetch(`${TRIP_PROXY_URL}${qs}`, `${LOCAL_RELAY_TRIP_URL}${qs}`, parseTripDetail);
}
