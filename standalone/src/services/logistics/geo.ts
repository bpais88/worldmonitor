// Pure great-circle geometry helpers for ocean-leg ETA + destination inference.
// Intentionally dependency-free so the module is trivially unit-testable.

import type { LatLon } from './types';

const EARTH_RADIUS_KM = 6371.0088;
const KNOTS_TO_KMH = 1.852;

const toRad = (deg: number): number => (deg * Math.PI) / 180;
const toDeg = (rad: number): number => (rad * 180) / Math.PI;

/** Great-circle distance between two points in kilometres. */
export function haversineKm(a: LatLon, b: LatLon): number {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial bearing (forward azimuth) from a to b, degrees 0-360. */
export function initialBearingDeg(a: LatLon, b: LatLon): number {
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const dLon = toRad(b.lon - a.lon);
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/** Smallest absolute difference between two bearings, degrees 0-180. */
export function bearingDeltaDeg(a: number, b: number): number {
  return Math.abs(((a - b + 540) % 360) - 180);
}

/** Convert speed in knots to km/h. */
export function knotsToKmh(knots: number): number {
  return knots * KNOTS_TO_KMH;
}
