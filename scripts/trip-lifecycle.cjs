'use strict';

// Pure decision logic for the Phase B trips lifecycle — the ANCHOR side, driven by the ferry-delay
// loop (updateFerryDelays). The relay owns the in-memory tripByMmsi map + all Postgres dispatch; this
// module only DECIDES what to do for one vessel on one tick, given its prior trip state + the current
// voyage anchor. Pure + unit-tested, mirroring eta-history.cjs / geofence-engine.cjs.
//
// The geofence side (CLOSE on destination-enter + origin/dwell backfill) is handled separately in the
// relay's geofence loop — NOT here.

const DEFAULTS = {
  minPointGapMs: 5 * 60_000, // trip_points downsample: at most one point per 5 min per trip
  destStableTicks: 2,        // a re-routed destination must hold this many ticks before we act (AIS
                             // destination strings flicker; without this, a flicker churns trips)
};

// tripState (per mmsi, owned by the relay), the shape decideTrip reads + returns as nextState:
//   { tripId: number|null,        // Postgres id (null until openTrip resolves; the relay patches it)
//     destPortId: string,         // the open trip's destination
//     openedAt: number,           // = voyage.startTs (never wall-clock → restart-stable)
//     status: 'open'|'arrived',   // 'arrived' set by the geofence CLOSE (relay), stops point capture
//     lastPointTs: number,        // last trip_point capture ms (0 = none yet)
//     stalledMarked: boolean, etaPatched: boolean,
//     pendingDest: string|null, pendingTicks: number }  // re-route flicker-stability guard

/**
 * Decide the lifecycle actions for one vessel this tick. Pure: no I/O, no mutation of inputs.
 *
 * @param prev   the relay's current tripState for this mmsi (or undefined/null)
 * @param voyage updateVoyage() result this tick: { destPortId, startTs, departureEtaTs } (or null)
 * @param ctx    { now, fresh, speedStalled, etaSlipMin, opts } — plain values from the tick
 * @returns { actions, nextState } — actions the relay dispatches; nextState to store (null = delete)
 *   action types: { type:'abandon', tripId } | { type:'open', destPortId, openedAt, departureEta }
 *     | { type:'capturePoint', tripId } | { type:'markStalled', tripId }
 *     | { type:'patchEta', tripId, etaTs } | { type:'bumpSlip', tripId, slipMin }
 */
function decideTrip(prev, voyage, ctx) {
  const { now, fresh, speedStalled, etaSlipMin } = ctx;
  const O = { ...DEFAULTS, ...(ctx.opts || {}) };
  const actions = [];

  // No destination this tick → the anchor is gone. Abandon any open trip; forget the vessel.
  if (!voyage) {
    if (prev && prev.tripId != null && prev.status === 'open') actions.push({ type: 'abandon', tripId: prev.tripId });
    return { actions, nextState: null };
  }

  // Re-route detection with a flicker-stability guard: the destination differs from the tracked
  // trip's. Require the NEW dest to hold destStableTicks consecutive ticks before acting on it.
  if (prev && prev.destPortId !== voyage.destPortId) {
    const pendingTicks = prev.pendingDest === voyage.destPortId ? prev.pendingTicks + 1 : 1;
    if (pendingTicks < O.destStableTicks) {
      return { actions, nextState: { ...prev, pendingDest: voyage.destPortId, pendingTicks } };
    }
    // Stable re-route: abandon the old open trip (never fabricate an arrival), then open the new leg.
    if (prev.tripId != null && prev.status === 'open') actions.push({ type: 'abandon', tripId: prev.tripId });
    prev = null; // fall through to open-new
  } else if (prev && prev.pendingDest) {
    prev = { ...prev, pendingDest: null, pendingTicks: 0 }; // dest settled back — clear the counter
  }

  // OPEN a new trip when nothing is tracked for this (mmsi, dest). tripId is null until the relay's
  // openTrip resolves; point capture waits for it.
  if (!prev) {
    actions.push({ type: 'open', destPortId: voyage.destPortId, openedAt: voyage.startTs, departureEta: voyage.departureEtaTs });
    return {
      actions,
      nextState: {
        tripId: null, destPortId: voyage.destPortId, openedAt: voyage.startTs, status: 'open',
        lastPointTs: 0, stalledMarked: false, etaPatched: Number.isFinite(voyage.departureEtaTs),
        pendingDest: null, pendingTicks: 0,
      },
    };
  }

  // Existing tracked trip (same dest) — decorate it while it's open and its id is known.
  const next = { ...prev };
  if (prev.tripId != null && prev.status === 'open') {
    if (fresh && now - prev.lastPointTs >= O.minPointGapMs) {
      actions.push({ type: 'capturePoint', tripId: prev.tripId });
      next.lastPointTs = now;
    }
    if (speedStalled && !prev.stalledMarked) {
      actions.push({ type: 'markStalled', tripId: prev.tripId });
      next.stalledMarked = true;
    }
    if (!prev.etaPatched && Number.isFinite(voyage.departureEtaTs)) {
      actions.push({ type: 'patchEta', tripId: prev.tripId, etaTs: voyage.departureEtaTs });
      next.etaPatched = true;
    }
    if (Number.isFinite(etaSlipMin) && etaSlipMin > 0) {
      actions.push({ type: 'bumpSlip', tripId: prev.tripId, slipMin: etaSlipMin });
    }
  }
  return { actions, nextState: next };
}

module.exports = { decideTrip, DEFAULTS };
