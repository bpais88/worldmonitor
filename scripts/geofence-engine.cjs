'use strict';

// Geofence engine — the reusable primitive behind port-zone monitoring.
//
// A geofence = identity + geometry + rules + style + metadata. Today the only
// geofences are one circle per commercial port (seeded from the shared ports
// dataset, radius = the existing "atPort" 8 km), but the model is polygon-ready
// and kind-tagged so custom zones (anchorage / chokepoint / risk / customer)
// drop in later without a schema change.
//
// Two jobs, both pure + testable:
//   1. define/seed geofences (buildPortGeofences)
//   2. detect which vessels are inside each zone (computeMembership) and diff
//      tick-to-tick into enter/exit events with dwell (diffMembership) — the
//      arrivals/departures/dwell signal the congestion forecast needs, and the
//      event stream a customer-facing alert layer will consume.
//
// The relay owns the timers + persistence; this module stays I/O-free.

const { haversineKm } = require('./ferry-eta.cjs');

// "atPort" radius in port-status.cjs — kept in sync so a port geofence and the
// congestion count describe the same circle.
const DEFAULT_PORT_RADIUS_KM = 8;
const DEFAULT_DWELL_MIN = 30;

// Render styling per zone kind (consumed by the ferry.html "Zones" overlay).
const KIND_STYLE = {
  port: { color: '#2fbf85', fillOpacity: 0.08 },
  anchorage: { color: '#e0a032', fillOpacity: 0.08 },
  chokepoint: { color: '#6ea8fe', fillOpacity: 0.06 },
  risk: { color: '#f06a62', fillOpacity: 0.10 },
  custom: { color: '#b39ddb', fillOpacity: 0.08 },
};

/**
 * Seed one circular geofence per commercial port. Deterministic from the ports
 * dataset — the default set that a future admin edit layer (Redis-backed) would
 * override. `updatedBy: 'system'` marks these as defaults, not human edits.
 */
function buildPortGeofences(ports, opts = {}) {
  const radiusKm = opts.radiusKm || DEFAULT_PORT_RADIUS_KM;
  const dwellMin = opts.dwellMin || DEFAULT_DWELL_MIN;
  const out = [];
  for (const p of ports || []) {
    if (!p || p.commercial !== true) continue;
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon)) continue;
    out.push({
      id: `${p.id}-port`,
      portId: p.id,
      name: `${p.name} — port area`,
      kind: 'port',
      geometry: { type: 'circle', center: { lat: p.lat, lon: p.lon }, radiusKm },
      rules: { events: ['enter', 'exit', 'dwell'], dwellMin, appliesTo: 'freight' },
      style: KIND_STYLE.port,
      enabled: true,
      updatedAt: 0,
      updatedBy: 'system',
    });
  }
  return out;
}

/** Point-in-polygon (ray casting) against a ring of {lat, lon} vertices. */
function pointInRing(lat, lon, ring) {
  if (!Array.isArray(ring) || ring.length < 3) return false;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const yi = ring[i].lat;
    const xi = ring[i].lon;
    const yj = ring[j].lat;
    const xj = ring[j].lon;
    const denom = (yj - yi) || 1e-12;
    const intersect = ((yi > lat) !== (yj > lat)) && (lon < ((xj - xi) * (lat - yi)) / denom + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

/** Is a coordinate inside a geofence's geometry? Disabled/invalid → false. */
function isInside(lat, lon, geofence) {
  if (!geofence || geofence.enabled === false) return false;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  const g = geofence.geometry;
  if (!g) return false;
  if (g.type === 'circle') {
    if (!g.center || !Number.isFinite(g.radiusKm)) return false;
    return haversineKm({ lat, lon }, g.center) <= g.radiusKm;
  }
  if (g.type === 'polygon') {
    return pointInRing(lat, lon, g.ring);
  }
  return false;
}

/**
 * Current membership: Map<geofenceId, Set<mmsi>> of the vessels inside each zone.
 * O(vessels × geofences) — fine at ~2k vessels × ~40 zones (one haversine each).
 */
function computeMembership(vessels, geofences) {
  const membership = new Map();
  for (const gf of geofences) membership.set(gf.id, new Set());
  for (const v of vessels || []) {
    if (!v || v.mmsi == null || !Number.isFinite(v.lat) || !Number.isFinite(v.lon)) continue;
    for (const gf of geofences) {
      if (isInside(v.lat, v.lon, gf)) membership.get(gf.id).add(v.mmsi);
    }
  }
  return membership;
}

/**
 * Diff previous → current membership into enter/exit events. On exit, dwellMin is
 * the time the vessel spent inside (arrivals − departures − dwell = the forecast's
 * mass-balance terms). `enterTimes` (Map<`${gfId}:${mmsi}`, ts>) is mutated to
 * carry entry timestamps across ticks; pass the same Map each call.
 */
function diffMembership(prev, next, now, enterTimes, geofences) {
  const events = [];
  const portByGf = new Map((geofences || []).map((g) => [g.id, g.portId]));
  for (const [gfId, currSet] of next) {
    const prevSet = prev.get(gfId) || new Set();
    const portId = portByGf.get(gfId);
    for (const mmsi of currSet) {
      if (!prevSet.has(mmsi)) {
        enterTimes.set(`${gfId}:${mmsi}`, now);
        events.push({ ts: now, gfId, portId, mmsi, kind: 'enter' });
      }
    }
    for (const mmsi of prevSet) {
      if (!currSet.has(mmsi)) {
        const key = `${gfId}:${mmsi}`;
        const enteredAt = enterTimes.get(key);
        const dwellMin = Number.isFinite(enteredAt) ? Math.round((now - enteredAt) / 60000) : null;
        enterTimes.delete(key);
        events.push({ ts: now, gfId, portId, mmsi, kind: 'exit', dwellMin });
      }
    }
  }
  return events;
}

module.exports = {
  DEFAULT_PORT_RADIUS_KM,
  DEFAULT_DWELL_MIN,
  KIND_STYLE,
  buildPortGeofences,
  pointInRing,
  isInside,
  computeMembership,
  diffMembership,
};
