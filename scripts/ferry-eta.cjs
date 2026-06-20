'use strict';

// Relay-side destination resolution + ETA, mirroring src/services/logistics/
// ferry.ts (matchDestinationPort) and eta.ts (computeEta). Pure CommonJS so the
// relay can require it. Static data is single-sourced from italy-ferries.data.json.

const data = require('../src/config/italy-ferries.data.json');

const PORT_BY_ID = new Map(data.ports.map((p) => [p.id, p]));

// Tokens crews append for round trips ("e viceversa") — not destinations.
const ROUNDTRIP_TOKENS = new Set(['VV', 'V', 'E', 'EVV', 'RT', 'AR', 'ANDATA', 'RITORNO']);

function toResult(port) {
  if (!port) return null;
  return { portId: port.id, name: port.name, lat: port.lat, lon: port.lon };
}

/** Resolve an AIS destination string to a known port, or null. */
function resolveDestinationPort(destString) {
  if (!destString) return null;
  const compact = String(destString).toUpperCase().replace(/[^A-Z0-9]/g, '');

  // LOCODE match: de-spaced so "IT NAP" == "ITNAP"; pick the code appearing
  // latest in the string (the final leg of a multi-leg / round-trip voyage).
  let bestIdx = -1;
  let bestPortId;
  for (const code of Object.keys(data.locodes)) {
    const idx = compact.lastIndexOf(code);
    if (idx > bestIdx) {
      bestIdx = idx;
      bestPortId = data.locodes[code];
    }
  }
  if (bestPortId) return toResult(PORT_BY_ID.get(bestPortId));

  // Name match, per token from the end (so "NAPOLI/CAPRI" -> Capri).
  const upper = String(destString).toUpperCase();
  const tokens = upper.split(/[^A-Z0-9]+/).filter((t) => t.length >= 3 && !ROUNDTRIP_TOKENS.has(t));
  for (let i = tokens.length - 1; i >= 0; i--) {
    const token = tokens[i];
    for (const port of data.ports) {
      if (port.aisNames.some((n) => token.includes(n))) return toResult(port);
    }
  }

  // Whole-string fallback for multi-word names ("VILLA S GIOVANNI").
  const spaced = upper.replace(/[^A-Z ]/g, ' ');
  for (const port of data.ports) {
    if (port.aisNames.some((n) => spaced.includes(n))) return toResult(port);
  }

  return null;
}

const MIN_UNDERWAY_KNOTS = 0.5;
const MS_PER_HOUR = 3_600_000;
const EARTH_RADIUS_KM = 6371;

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

/** Great-circle distance in km. */
function haversineKm(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
}

/**
 * Time-to-arrival for a vessel heading to a port: great-circle distance over
 * current speed. Returns null when stopped/speed unknown (no bogus ETA).
 */
function etaFor(vessel, port, now = Date.now()) {
  const speed = vessel && Number.isFinite(vessel.speedKnots) ? vessel.speedKnots : 0;
  if (!port || speed < MIN_UNDERWAY_KNOTS) return null;
  const distanceKm = haversineKm(vessel, port);
  const hoursRemaining = distanceKm / (speed * 1.852); // knots -> km/h
  return { hoursRemaining, etaTs: Math.round(now + hoursRemaining * MS_PER_HOUR) };
}

module.exports = { resolveDestinationPort, etaFor, haversineKm };
