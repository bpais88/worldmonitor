// Orchestration: turn live AIS vessels into a board of tracked Italian ferries.
//
// Pulls vessels in the Italy viewport from a VesselDataProvider, keeps the ones
// that look like Italian island ferries, resolves each one's destination + ETA,
// and derives a coarse status (in port / at anchor / under way).

import type { VesselDataProvider, LiveVessel } from './providers/types';
import { aisStreamProvider } from './providers/aisstream';
import type { EtaSource } from './types';
import {
  EUROPE_BBOX,
  ITALY_FERRY_PORTS,
  ITALY_FERRY_OPERATORS,
} from '../../config/italy-ferries';
import { isFreightVessel, matchItalianFerryOperator, estimateFerryEta } from './ferry';
import { validateSailing, type RouteStatus } from './route-validation';

export type FerryStatus = 'under_way' | 'at_anchor' | 'in_port';

export interface TrackedFerry {
  mmsi: string;
  name: string;
  operatorId?: string;
  operatorName?: string;
  lat: number;
  lon: number;
  speedKnots?: number;
  courseDeg?: number;
  /** Overall hull length in metres (from ShipStaticData). */
  lengthMeters?: number;
  /** Hull beam in metres. */
  beamMeters?: number;
  /** Max static draught in metres (load indicator). */
  draughtMeters?: number;
  /** AIS call sign. */
  callSign?: string;
  /** Crew-entered AIS ETA, "MM-DD HH:MMZ" (UTC), if present. */
  etaAis?: string;
  /** Relay-computed delay status (ETA drift / stalled), if flagged. */
  delay?: {
    slipping?: boolean;
    stalled?: boolean;
    etaGrowthMin?: number;
    reasons?: { source: string; kind: string; summary: string; confidence: number; url?: string }[];
  };
  status: FerryStatus;
  destinationPortId?: string;
  destinationName?: string;
  destinationGroup?: string;
  etaSource?: EtaSource;
  etaTimestamp: number | null;
  hoursRemaining: number | null;
  confidence: number;
  /** Whether the resolved destination matches a known scheduled route. */
  routeStatus: RouteStatus;
  timestamp: number;
}

const PORT_BY_ID = new Map(ITALY_FERRY_PORTS.map((p) => [p.id, p] as const));
const OPERATOR_BY_ID = new Map(ITALY_FERRY_OPERATORS.map((o) => [o.id, o] as const));

// AIS navigational status codes we care about.
const NAV_STATUS_AT_ANCHOR = 1;
const NAV_STATUS_MOORED = 5;
const MIN_UNDERWAY_KNOTS = 0.5;

function deriveStatus(v: LiveVessel): FerryStatus {
  if (v.navStatus === NAV_STATUS_MOORED) return 'in_port';
  if (v.navStatus === NAV_STATUS_AT_ANCHOR) return 'at_anchor';
  const speed = v.speedKnots ?? 0;
  return speed < MIN_UNDERWAY_KNOTS ? 'in_port' : 'under_way';
}

const STATUS_RANK: Record<FerryStatus, number> = { under_way: 0, at_anchor: 1, in_port: 2 };

/** Convert one live vessel into a TrackedFerry (destination + ETA resolved). */
export function toTrackedFerry(v: LiveVessel, now: number = Date.now()): TrackedFerry {
  // Operator id/name from the relay (authoritative) when present; else derive
  // from the name as a fallback so older relay builds still work.
  const operatorId = v.operatorId || matchItalianFerryOperator(v.name);
  const operatorName = v.operatorName || (operatorId ? OPERATOR_BY_ID.get(operatorId)?.name : undefined);
  const eta = estimateFerryEta(v, now);
  const port = eta ? PORT_BY_ID.get(eta.destinationPortId) : undefined;
  // Snapshot has no origin yet (that needs port-call history), so validate on
  // destination + operator. Upgrades to 'confirmed' once an origin is known.
  const routeStatus = validateSailing({ destinationPortId: port?.id, operatorId }).status;

  return {
    mmsi: v.mmsi,
    name: v.name || `MMSI ${v.mmsi}`,
    operatorId,
    operatorName,
    lat: v.lat,
    lon: v.lon,
    speedKnots: v.speedKnots,
    courseDeg: v.courseDeg,
    lengthMeters: v.lengthMeters,
    beamMeters: v.beamMeters,
    draughtMeters: v.draughtMeters,
    callSign: v.callSign,
    etaAis: v.etaAis,
    delay: v.delay && (v.delay.slipping || v.delay.stalled)
      ? {
          slipping: v.delay.slipping,
          stalled: v.delay.stalled,
          etaGrowthMin: v.delay.etaGrowthMin,
          reasons: v.delay.reasons,
        }
      : undefined,
    status: deriveStatus(v),
    destinationPortId: port?.id,
    destinationName: port?.name,
    destinationGroup: port?.group,
    etaSource: eta?.source,
    etaTimestamp: eta?.etaTimestamp ?? null,
    hoursRemaining: eta?.hoursRemaining ?? null,
    confidence: eta?.confidence ?? 0,
    routeStatus,
    timestamp: v.timestamp,
  };
}

/** Sort: under-way first, then soonest ETA, then name. */
export function sortFerries(a: TrackedFerry, b: TrackedFerry): number {
  const byStatus = STATUS_RANK[a.status] - STATUS_RANK[b.status];
  if (byStatus !== 0) return byStatus;
  const aEta = a.hoursRemaining ?? Number.POSITIVE_INFINITY;
  const bEta = b.hoursRemaining ?? Number.POSITIVE_INFINITY;
  if (aEta !== bEta) return aEta - bEta;
  return a.name.localeCompare(b.name);
}

/** Build the tracked freight-vessel board from a set of live vessels (pure). */
export function buildFerryBoard(vessels: LiveVessel[], now: number = Date.now()): TrackedFerry[] {
  return vessels
    .filter((v) => isFreightVessel(v))
    .map((v) => toTrackedFerry(v, now))
    .sort(sortFerries);
}

/**
 * Fetch and build the live freight-vessel board from a provider. Queries the
 * Europe-wide union box (Italy + UK + Spain + Netherlands); the UI filters the
 * result down to a selected region client-side via {@link regionOf}.
 */
export async function getTrackedFreightVessels(
  provider: VesselDataProvider = aisStreamProvider,
  now: number = Date.now(),
): Promise<TrackedFerry[]> {
  const vessels = await provider.getVesselsInBounds({
    bbox: EUROPE_BBOX,
    categories: ['cargo', 'passenger'],
    freight: true,
    // Europe-wide holds ~2.2k freight vessels (vs a few hundred for Italy alone);
    // 5000 leaves headroom so a busy North Sea peak isn't silently truncated.
    limit: 5000,
  });
  return buildFerryBoard(vessels, now);
}
