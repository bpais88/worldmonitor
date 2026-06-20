// Port-call detection: derive departure/arrival milestones from vessel behaviour.
//
// AIS broadcasts a (declared) destination but never an origin. We recover both
// the origin and concrete milestones by watching a vessel transition in and out
// of a known port's vicinity:
//   - moored/slow inside a port radius  => "at" that port
//   - was at a port, now moving away     => DEPARTED that port
//   - was at sea, now moored at a port   => ARRIVED at that port

import { ITALY_FERRY_PORTS, type FerryPort } from '../../config/italy-ferries';
import { haversineKm } from './geo';
import type { LiveVessel } from './providers/types';
import type { Milestone } from './types';

/** A vessel within this distance of a port is considered "at" it. */
export const PORT_PROXIMITY_KM = 5;
/** Max speed (knots) to count as moored/manoeuvring rather than transiting. */
export const AT_PORT_MAX_KNOTS = 3;

const PORT_BY_ID = new Map(ITALY_FERRY_PORTS.map((p) => [p.id, p] as const));

/** Nearest ferry port within maxKm of a point, if any. */
export function findNearestPort(
  lat: number,
  lon: number,
  maxKm: number = PORT_PROXIMITY_KM,
): { port: FerryPort; distanceKm: number } | undefined {
  let best: { port: FerryPort; distanceKm: number } | undefined;
  for (const port of ITALY_FERRY_PORTS) {
    const distanceKm = haversineKm({ lat, lon }, port);
    if (distanceKm > maxKm) continue;
    if (!best || distanceKm < best.distanceKm) best = { port, distanceKm };
  }
  return best;
}

/** A vessel's relationship to ports at one point in time. */
export interface PortState {
  mmsi: string;
  /** Port the vessel is currently berthed/manoeuvring at, or null if at sea. */
  atPortId: string | null;
  at: number;
}

export type PortEventType = 'departed' | 'arrived';

export interface PortEvent {
  mmsi: string;
  type: PortEventType;
  portId: string;
  portName: string;
  at: number;
}

/** Whether a vessel currently counts as "at" a port (slow + inside the radius). */
export function computePortState(v: LiveVessel): PortState {
  const speed = v.speedKnots ?? 0;
  const slow = speed <= AT_PORT_MAX_KNOTS;
  const nearest = slow ? findNearestPort(v.lat, v.lon) : undefined;
  return { mmsi: v.mmsi, atPortId: nearest?.port.id ?? null, at: v.timestamp };
}

/** Compare two states for the same vessel and emit a port event on transition. */
export function detectPortEvent(prev: PortState | undefined, curr: PortState): PortEvent | null {
  // No prior observation => we can't claim a transition (it may have been
  // berthed long before we started watching).
  if (!prev) return null;

  const prevPort = prev.atPortId;
  const currPort = curr.atPortId;
  if (prevPort === currPort) return null;

  // Arrived: was at sea (or elsewhere), now at a port.
  if (currPort && currPort !== prevPort) {
    return {
      mmsi: curr.mmsi,
      type: 'arrived',
      portId: currPort,
      portName: PORT_BY_ID.get(currPort)?.name ?? currPort,
      at: curr.at,
    };
  }
  // Departed: was at a port, now at sea.
  if (prevPort && !currPort) {
    return {
      mmsi: curr.mmsi,
      type: 'departed',
      portId: prevPort,
      portName: PORT_BY_ID.get(prevPort)?.name ?? prevPort,
      at: curr.at,
    };
  }
  return null;
}

/** Convert a port event into a shipment milestone. */
export function portEventToMilestone(event: PortEvent): Milestone {
  return {
    type: event.type === 'departed' ? 'departed' : 'arrived',
    at: event.at,
    portId: event.portId,
    note: `${event.type === 'departed' ? 'Departed' : 'Arrived'} ${event.portName}`,
  };
}

/**
 * Stateful tracker: feed sequential vessel positions, get departure/arrival
 * events as they happen. One instance tracks many vessels by MMSI.
 */
export class PortCallTracker {
  private states = new Map<string, PortState>();

  /** Returns a port event if this update crossed a port boundary, else null. */
  update(v: LiveVessel): PortEvent | null {
    const curr = computePortState(v);
    const prev = this.states.get(v.mmsi);
    this.states.set(v.mmsi, curr);
    return detectPortEvent(prev, curr);
  }

  /** Current at-port id for a vessel (null = at sea, undefined = unseen). */
  currentPort(mmsi: string): string | null | undefined {
    return this.states.get(mmsi)?.atPortId;
  }

  reset(): void {
    this.states.clear();
  }
}
