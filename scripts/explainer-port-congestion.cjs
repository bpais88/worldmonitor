'use strict';

// Port-congestion explainer: derives congestion at a ferry's destination port
// from our OWN live AIS — no external data. If many vessels are stopped/anchored
// around the destination, a delay there is likely congestion-driven.
//
// The pure assessment (port + vessel list -> reason) is unit-tested; the relay
// wires a factory over its live vessel map.

const { haversineKm } = require('./ferry-eta.cjs');

const DEFAULTS = {
  radiusKm: 8,           // "at the port" = within this of the terminal
  stoppedKnots: 1,       // at/below this counts as stopped
  minVessels: 4,         // congestion threshold
  freshMs: 30 * 60_000,  // ignore vessels that stopped reporting
};

const NAV_AT_ANCHOR = 1;
const NAV_MOORED = 5;

function isStopped(v, stoppedKnots) {
  if (v.navStatus === NAV_AT_ANCHOR || v.navStatus === NAV_MOORED) return true;
  return Number.isFinite(v.speed) && v.speed <= stoppedKnots;
}

/**
 * Count stopped vessels clustered at a destination port and, above a threshold,
 * return a congestion reason. Pure. `opts.excludeMmsi` skips the subject vessel.
 */
function assessPortCongestion(port, vessels, now = Date.now(), opts = {}) {
  if (!port || !Number.isFinite(port.lat) || !Number.isFinite(port.lon)) return null;
  if (!Array.isArray(vessels)) return null;
  const o = { ...DEFAULTS, ...opts };

  let count = 0;
  for (const v of vessels) {
    if (!v || v.mmsi === o.excludeMmsi) continue;
    if (!Number.isFinite(v.lat) || !Number.isFinite(v.lon)) continue;
    if (Number.isFinite(v.timestamp) && now - v.timestamp > o.freshMs) continue;
    if (!isStopped(v, o.stoppedKnots)) continue;
    if (haversineKm(v, port) > o.radiusKm) continue;
    count++;
  }

  if (count < o.minVessels) return null;
  return {
    source: 'port',
    kind: 'port_congestion',
    summary: `${port.name || 'Destination'} port congested — ${count} ferries waiting`,
    confidence: count >= 8 ? 0.75 : 0.6,
    detail: `${count} ferries stopped within ${o.radiusKm} km of the port`,
  };
}

/**
 * Relay-side explainer: closes over a getter for the live vessel list. The
 * destination port coords come from the enrichment context (destLat/destLon).
 */
function makePortCongestionExplainer(getVessels) {
  return {
    id: 'port',
    async explain(ctx) {
      if (!ctx || !Number.isFinite(ctx.destLat) || !Number.isFinite(ctx.destLon)) return [];
      const port = { lat: ctx.destLat, lon: ctx.destLon, name: ctx.destName };
      const reason = assessPortCongestion(port, getVessels(), Date.now(), { excludeMmsi: ctx.mmsi });
      return reason ? [reason] : [];
    },
  };
}

module.exports = { assessPortCongestion, makePortCongestionExplainer, DEFAULTS };
