// Route validation — cross-check a resolved sailing against the known schedule.
//
// Turns "this ferry is heading to Olbia" into "...on the scheduled
// Civitavecchia -> Olbia route (Tirrenia)", and flags anomalies: an
// origin/destination pair that no scheduled route covers (off-schedule, a new
// route, or a data issue worth surfacing).

import {
  ITALY_FERRY_ROUTES,
  ITALY_FERRY_PORTS,
  type FerryRoute,
} from '../../config/italy-ferries';

const routeKey = (fromId: string, toId: string): string => `${fromId}>${toId}`;

const ROUTE_BY_KEY = new Map(ITALY_FERRY_ROUTES.map((r) => [routeKey(r.fromId, r.toId), r] as const));
const PORT_IDS = new Set(ITALY_FERRY_PORTS.map((p) => p.id));

const ROUTES_BY_DEST = new Map<string, FerryRoute[]>();
for (const r of ITALY_FERRY_ROUTES) {
  const list = ROUTES_BY_DEST.get(r.toId) ?? [];
  list.push(r);
  ROUTES_BY_DEST.set(r.toId, list);
}

/** Is this exact origin -> destination pair a scheduled route? */
export function isKnownRoute(fromId: string, toId: string): boolean {
  return ROUTE_BY_KEY.has(routeKey(fromId, toId));
}

/** The scheduled route for a pair (with operator), if any. */
export function findRoute(fromId: string, toId: string): FerryRoute | undefined {
  return ROUTE_BY_KEY.get(routeKey(fromId, toId));
}

/** Scheduled routes that serve a destination (i.e. origins that reach it). */
export function routesTo(destId: string): FerryRoute[] {
  return ROUTES_BY_DEST.get(destId) ?? [];
}

function isKnownPort(portId: string | undefined): boolean {
  return !!portId && PORT_IDS.has(portId);
}

export type RouteStatus = 'confirmed' | 'plausible' | 'unknown';

export interface SailingInput {
  originPortId?: string;
  destinationPortId?: string;
  operatorId?: string;
}

export interface RouteValidation {
  status: RouteStatus;
  route?: FerryRoute;
  /** Operator the schedule expects on this route, if known. */
  expectedOperatorId?: string;
  /** False when the observed operator differs from the scheduled one. */
  operatorMatch?: boolean;
  note?: string;
}

/**
 * Validate a resolved sailing against the schedule table.
 *   - confirmed: origin + destination match a scheduled route
 *   - plausible: destination is a known ferry port (origin not yet known)
 *   - unknown:   both ports known but no scheduled route (anomaly), or no
 *                destination resolved at all
 */
export function validateSailing(input: SailingInput): RouteValidation {
  const { originPortId, destinationPortId, operatorId } = input;

  if (originPortId && destinationPortId) {
    const route = findRoute(originPortId, destinationPortId);
    if (route) {
      const operatorMatch = !operatorId || !route.operatorId || route.operatorId === operatorId;
      return {
        status: 'confirmed',
        route,
        expectedOperatorId: route.operatorId,
        operatorMatch,
        note: operatorMatch
          ? undefined
          : `operator ${operatorId} differs from scheduled ${route.operatorId}`,
      };
    }
    return { status: 'unknown', note: 'origin/destination pair not in scheduled routes' };
  }

  if (destinationPortId) {
    if (isKnownPort(destinationPortId)) {
      const serving = routesTo(destinationPortId);
      return {
        status: 'plausible',
        note: serving.length > 0
          ? 'destination served by scheduled routes'
          : 'known destination (not in representative schedule)',
      };
    }
    return { status: 'unknown', note: 'unrecognized destination' };
  }

  return { status: 'unknown', note: 'no destination resolved' };
}
