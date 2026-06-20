// Italian island-ferry identification + destination resolution.
//
// Given a live AIS vessel position, decide (a) whether it's an Italian island
// ferry and (b) where it's heading, then hand off to the ETA engine. Two
// resolution strategies, strongest first:
//   1. Parse the AIS destination field against known island ports.
//   2. Infer the destination from course-over-ground toward nearby islands.

import type { VesselPosition, EtaEstimate } from './types';
import {
  ITALY_FERRY_PORTS,
  ITALY_FERRY_OPERATORS,
  PORT_LOCODES,
  type FerryPort,
} from '../../config/italy-ferries';
import { computeEta } from './eta';
import { haversineKm, initialBearingDeg, bearingDeltaDeg } from './geo';

/** AIS ship-type codes 60-69 = passenger vessels (ferries). */
export function isFerryShipType(shipType: number | undefined): boolean {
  return typeof shipType === 'number' && shipType >= 60 && shipType <= 69;
}

/** Match a vessel name against known Italian ferry operators; returns operator id. */
export function matchItalianFerryOperator(name: string | undefined): string | undefined {
  if (!name) return undefined;
  const upper = name.toUpperCase();
  for (const op of ITALY_FERRY_OPERATORS) {
    if (op.keywords.some((k) => upper.includes(k))) return op.id;
  }
  return undefined;
}

/** True if a vessel looks like an Italian island ferry (by operator, or Italian-flag passenger). */
export function isItalianFerry(vessel: Pick<VesselPosition, 'name' | 'shipType' | 'mmsi'>): boolean {
  if (matchItalianFerryOperator(vessel.name)) return true;
  // Italian flag = MMSI MID 247, combined with a passenger ship type.
  const italianFlag = typeof vessel.mmsi === 'string' && vessel.mmsi.startsWith('247');
  return italianFlag && isFerryShipType(vessel.shipType);
}

const ISLAND_PORTS = ITALY_FERRY_PORTS.filter((p) => p.side === 'island');
const PORT_BY_ID = new Map(ITALY_FERRY_PORTS.map((p) => [p.id, p] as const));

// Tokens crews append for round trips ("e viceversa") — not destinations.
const ROUNDTRIP_TOKENS = new Set(['VV', 'V', 'E', 'EVV', 'RT', 'AR', 'ANDATA', 'RITORNO']);

/**
 * Match the free-text AIS destination field to a known port.
 *
 * Handles the common real-world formats: a single port name ("OLBIA"), a
 * UN/LOCODE ("ITNAP" or spaced "IT NAP"), and multi-leg / round-trip strings
 * ("ITPOZ<>ITPRO", "ITFRD-ITISH-ITNAP", "ITNAP ITISH E VV"). The final/most-
 * recent destination wins, so legs/codes are resolved from the end of the string.
 */
export function matchDestinationPort(aisDestination: string | undefined): FerryPort | undefined {
  if (!aisDestination) return undefined;
  const upper = aisDestination.toUpperCase();

  // 1. LOCODE match. De-space first so "IT NAP" == "ITNAP", then take the code
  //    that appears latest (the final leg of a multi-leg voyage string).
  const compact = upper.replace(/[^A-Z0-9]/g, '');
  let bestIdx = -1;
  let bestPort: FerryPort | undefined;
  for (const code of Object.keys(PORT_LOCODES)) {
    const idx = compact.lastIndexOf(code);
    if (idx > bestIdx) {
      bestIdx = idx;
      const portId = PORT_LOCODES[code];
      bestPort = portId ? PORT_BY_ID.get(portId) : undefined;
    }
  }
  if (bestPort) return bestPort;

  // 2. Name match, per token, from the end (so "NAPOLI/CAPRI" -> Capri).
  const tokens = upper.split(/[^A-Z0-9]+/).filter((t) => t.length >= 3 && !ROUNDTRIP_TOKENS.has(t));
  for (let i = tokens.length - 1; i >= 0; i--) {
    const token = tokens[i] as string;
    for (const port of ITALY_FERRY_PORTS) {
      if (port.aisNames.some((n) => token.includes(n))) return port;
    }
  }

  // 3. Whole-string fallback for multi-word port names ("VILLA S GIOVANNI").
  const spaced = upper.replace(/[^A-Z ]/g, ' ');
  for (const port of ITALY_FERRY_PORTS) {
    if (port.aisNames.some((n) => spaced.includes(n))) return port;
  }
  return undefined;
}

/** Course must align within this many degrees of bearing-to-port to count. */
export const MAX_BEARING_DELTA_DEG = 35;
/** Don't infer destinations farther than this from the vessel. */
export const MAX_INFERENCE_RANGE_KM = 350;

/**
 * Infer the most likely island destination for an under-way ferry from its
 * position and course over ground. Scores island ports by how closely the
 * bearing-to-port aligns with the vessel's course, preferring nearer ports.
 */
export function inferDestinationByCourse(
  vessel: VesselPosition,
): { port: FerryPort; confidence: number } | undefined {
  if (vessel.courseDeg === undefined || !Number.isFinite(vessel.courseDeg)) return undefined;

  let best: { port: FerryPort; score: number; delta: number } | undefined;
  for (const port of ISLAND_PORTS) {
    const bearing = initialBearingDeg(vessel, port);
    const delta = bearingDeltaDeg(bearing, vessel.courseDeg);
    if (delta > MAX_BEARING_DELTA_DEG) continue;
    const distance = haversineKm(vessel, port);
    if (distance > MAX_INFERENCE_RANGE_KM) continue;
    // Lower bearing delta + nearer port = better. 50km ~= 1 degree of penalty.
    const score = delta + distance / 50;
    if (!best || score < best.score) best = { port, score, delta };
  }
  if (!best) return undefined;

  // Course inference is a heuristic — cap confidence below AIS-declared.
  const confidence = (1 - best.delta / MAX_BEARING_DELTA_DEG) * 0.6;
  return { port: best.port, confidence: Math.max(0.2, confidence) };
}

/**
 * Resolve a ferry's destination and compute its ETA. Returns undefined when no
 * destination can be determined (e.g. berthed with no AIS destination set).
 */
export function estimateFerryEta(
  vessel: VesselPosition,
  now: number = Date.now(),
): EtaEstimate | undefined {
  // 1. Trust the AIS destination field first.
  const declared = matchDestinationPort(vessel.destination);
  if (declared) {
    return computeEta(vessel, declared, declared.id, 'ais_destination', 0.9, now);
  }
  // 2. Fall back to course-based inference toward island ports.
  const inferred = inferDestinationByCourse(vessel);
  if (inferred) {
    return computeEta(vessel, inferred.port, inferred.port.id, 'course_inference', inferred.confidence, now);
  }
  return undefined;
}
