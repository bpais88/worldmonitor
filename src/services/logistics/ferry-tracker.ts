// Orchestration: turn live AIS vessels into a board of tracked Italian ferries.
//
// Pulls vessels in the Italy viewport from a VesselDataProvider, keeps the ones
// that look like Italian island ferries, resolves each one's destination + ETA,
// and derives a coarse status (in port / at anchor / under way).

import type { VesselDataProvider, LiveVessel } from './providers/types';
import { aisStreamProvider } from './providers/aisstream';
import type { EtaSource } from './types';
import {
  ITALY_BBOX,
  ITALY_FERRY_PORTS,
  ITALY_FERRY_OPERATORS,
} from '../../config/italy-ferries';
import { isItalianFerry, matchItalianFerryOperator, estimateFerryEta } from './ferry';
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
  const operatorId = matchItalianFerryOperator(v.name);
  const eta = estimateFerryEta(v, now);
  const port = eta ? PORT_BY_ID.get(eta.destinationPortId) : undefined;
  // Snapshot has no origin yet (that needs port-call history), so validate on
  // destination + operator. Upgrades to 'confirmed' once an origin is known.
  const routeStatus = validateSailing({ destinationPortId: port?.id, operatorId }).status;

  return {
    mmsi: v.mmsi,
    name: v.name || `MMSI ${v.mmsi}`,
    operatorId,
    operatorName: operatorId ? OPERATOR_BY_ID.get(operatorId)?.name : undefined,
    lat: v.lat,
    lon: v.lon,
    speedKnots: v.speedKnots,
    courseDeg: v.courseDeg,
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

/** Build the tracked-ferry board from a set of live vessels (pure). */
export function buildFerryBoard(vessels: LiveVessel[], now: number = Date.now()): TrackedFerry[] {
  return vessels
    .filter((v) => isItalianFerry(v))
    .map((v) => toTrackedFerry(v, now))
    .sort(sortFerries);
}

/** Fetch and build the live Italian ferry board from a provider. */
export async function getTrackedItalianFerries(
  provider: VesselDataProvider = aisStreamProvider,
  now: number = Date.now(),
): Promise<TrackedFerry[]> {
  const vessels = await provider.getVesselsInBounds({
    bbox: ITALY_BBOX,
    categories: ['passenger', 'hsc'],
    limit: 3000,
  });
  return buildFerryBoard(vessels, now);
}
