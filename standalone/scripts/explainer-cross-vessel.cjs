'use strict';

// Cross-vessel correlation explainer: distinguishes a *systemic* delay (many
// nearby ferries also slipping -> area-wide cause like weather/strike) from an
// *isolated* one (nearby ferries are fine -> likely vessel-specific, e.g.
// mechanical). Derived entirely from our own delay flags — no external data.
//
// Pure assessment over a ferry list with delayed flags; the relay wires a
// factory that supplies the live list.

const { haversineKm } = require('./ferry-eta.cjs');

const DEFAULTS = {
  radiusKm: 60,         // "same area" — a weather system / strike spans a region
  minDelayedPeers: 2,   // this many nearby delayed peers => systemic
  minObservedPeers: 3,  // need this many nearby ferries before calling it isolated
};

/**
 * Classify a flagged crossing against nearby ferries. Pure.
 * `ferries` = [{ mmsi, lat, lon, delayed }] (may include the subject; excluded).
 */
function assessCrossVessel(subject, ferries, opts = {}) {
  if (!subject || !Number.isFinite(subject.lat) || !Number.isFinite(subject.lon)) return null;
  if (!Array.isArray(ferries)) return null;
  const o = { ...DEFAULTS, ...opts };

  const peers = ferries.filter(
    (f) => f && f.mmsi !== subject.mmsi && Number.isFinite(f.lat) && Number.isFinite(f.lon)
      && haversineKm(f, subject) <= o.radiusKm,
  );
  const delayedPeers = peers.filter((p) => p.delayed).length;

  if (delayedPeers >= o.minDelayedPeers) {
    return {
      source: 'fleet',
      kind: 'systemic_delay',
      summary: `${delayedPeers} nearby ferries also delayed — likely an area-wide cause`,
      confidence: delayedPeers >= 3 ? 0.65 : 0.55,
      detail: `${delayedPeers} of ${peers.length} ferries within ${o.radiusKm} km are also delayed`,
    };
  }
  if (peers.length >= o.minObservedPeers && delayedPeers === 0) {
    return {
      source: 'fleet',
      kind: 'isolated_delay',
      summary: 'Only this ferry is delayed here — likely vessel-specific',
      confidence: 0.4,
      detail: `${peers.length} nearby ferries are running normally`,
    };
  }
  return null;
}

/** Relay-side explainer: closes over a getter for the live ferry list w/ delayed flags. */
function makeCrossVesselExplainer(getFerries) {
  return {
    id: 'fleet',
    async explain(ctx) {
      if (!ctx || !Number.isFinite(ctx.lat) || !Number.isFinite(ctx.lon)) return [];
      const reason = assessCrossVessel({ mmsi: ctx.mmsi, lat: ctx.lat, lon: ctx.lon }, getFerries());
      return reason ? [reason] : [];
    },
  };
}

module.exports = { assessCrossVessel, makeCrossVesselExplainer, DEFAULTS };
