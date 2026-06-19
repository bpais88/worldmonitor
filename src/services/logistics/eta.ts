// Ocean-leg ETA estimation.
//
// Naive distance-over-speed model: great-circle distance to the destination
// divided by current speed over ground. This is the free, no-integration
// baseline — Phase L3 replaces it with route-aware (canal/waypoint) and then
// ML-predicted ETAs once a paid feed is wired in.

import type { LatLon, VesselPosition, EtaEstimate, EtaSource } from './types';
import { haversineKm, knotsToKmh } from './geo';

/** Minimum speed (knots) for a vessel to be considered "under way" for ETA. */
export const MIN_UNDERWAY_KNOTS = 0.5;

const MS_PER_HOUR = 3_600_000;

/**
 * Estimate time-to-arrival for a vessel heading to a known destination point,
 * using great-circle distance and current speed over ground.
 *
 * Returns hoursRemaining/etaTimestamp = null when the vessel is stopped or
 * speed is unknown — callers should surface "berthed / awaiting departure"
 * rather than a bogus ETA.
 */
export function computeEta(
  vessel: VesselPosition,
  destination: LatLon,
  destinationPortId: string,
  source: EtaSource,
  confidence: number,
  now: number = Date.now(),
): EtaEstimate {
  const distanceKm = haversineKm(vessel, destination);
  const speed = vessel.speedKnots ?? 0;

  if (!Number.isFinite(speed) || speed < MIN_UNDERWAY_KNOTS) {
    return {
      destinationPortId,
      distanceKm,
      hoursRemaining: null,
      etaTimestamp: null,
      source,
      confidence,
    };
  }

  const hoursRemaining = distanceKm / knotsToKmh(speed);
  return {
    destinationPortId,
    distanceKm,
    hoursRemaining,
    etaTimestamp: now + hoursRemaining * MS_PER_HOUR,
    source,
    confidence,
  };
}
