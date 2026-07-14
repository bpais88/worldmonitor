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
  anchorGraceMs: 90 * 60_000, // hold an open trip this long after its anchor vanishes before
                              // abandoning. Prod evidence (2026-07-12): 93.7% of abandonments
                              // re-anchored the SAME dest (p50 gap 17min, p90 74min) — the anchor
                              // blinks (crew clears/garbles the dest string, a static frame goes
                              // missing) while the vessel sails on. 90min covers ~p90 and keeps the
                              // trip open for the geofence CLOSE (~2.6k arrivals/day were being
                              // abandoned minutes before their dest-enter fired).
};

// tripState (per mmsi, owned by the relay), the shape decideTrip reads + returns as nextState:
//   { tripId: number|null,        // Postgres id (null until openTrip resolves; the relay patches it)
//     destPortId: string,         // the open trip's destination
//     openedAt: number,           // = voyage.startTs (never wall-clock → restart-stable)
//     status: 'open'|'arrived',   // 'arrived' set by the geofence CLOSE (relay), stops point capture
//     lastPointTs: number,        // last trip_point capture ms (0 = none yet)
//     stalledMarked: boolean, etaPatched: boolean,
//     pendingDest: string|null, pendingTicks: number,  // re-route flicker-stability guard
//     anchorLostSince: number|null }                   // anchor-loss grace clock (null = anchored)

/**
 * Decide the lifecycle actions for one vessel this tick. Pure: no I/O, no mutation of inputs.
 *
 * @param prev   the relay's current tripState for this mmsi (or undefined/null)
 * @param voyage updateVoyage() result this tick: { destPortId, startTs, departureEtaTs } (or null)
 * @param ctx    { now, fresh, speedStalled, etaSlipMin, opts } — plain values from the tick
 * @returns { actions, nextState } — actions the relay dispatches; nextState to store (null = delete)
 *   action types: { type:'abandon', tripId, reason:'anchor_lost'|'reroute' }
 *     | { type:'open', destPortId, openedAt, departureEta }
 *     | { type:'resume', tripId }  (stats-only: anchor recovered within grace, same trip continues)
 *     | { type:'capturePoint', tripId } | { type:'markStalled', tripId }
 *     | { type:'patchEta', tripId, etaTs } | { type:'bumpSlip', tripId, slipMin }
 */
function decideTrip(prev, voyage, ctx) {
  const { now, fresh, speedStalled, etaSlipMin } = ctx;
  // Read the two tunables with a per-field fallback (no per-call object spread — this runs for every
  // freight vessel every tick). Callers pass a stable opts object (relay TRIP_OPTS); tests may omit it.
  const opts = ctx.opts || {};
  const minPointGapMs = opts.minPointGapMs ?? DEFAULTS.minPointGapMs;
  const destStableTicks = opts.destStableTicks ?? DEFAULTS.destStableTicks;
  const anchorGraceMs = opts.anchorGraceMs ?? DEFAULTS.anchorGraceMs;
  const actions = [];

  // No destination this tick → the anchor is gone. NOT proof the voyage ended: dest strings blink
  // for a tick while the vessel sails on (see DEFAULTS.anchorGraceMs). Start/continue the grace
  // clock on an open trip and only abandon once the loss has held for the full window — so the
  // same trip survives the blink (resume below) and stays closable by the geofence dest-enter.
  if (!voyage) {
    if (!prev || prev.status !== 'open') return { actions, nextState: null }; // arrived/abandoned → geofence/sweep owns the row; just forget
    const lostSince = prev.anchorLostSince ?? now;
    if (now - lostSince >= anchorGraceMs) {
      if (prev.tripId != null) actions.push({ type: 'abandon', tripId: prev.tripId, reason: 'anchor_lost' });
      return { actions, nextState: null };
    }
    // A null anchor also breaks the re-route stability window: destStableTicks means CONSECUTIVE
    // voyage ticks, so a pending flicker candidate is discarded on loss — A→B→null→B must re-earn
    // both ticks after the anchor returns, else B-null-B garble would supersede a healthy trip.
    const graced = prev.anchorLostSince != null && prev.pendingDest == null
      ? prev
      : { ...prev, anchorLostSince: lostSince, pendingDest: null, pendingTicks: 0 };
    return { actions, nextState: graced };
  }

  // Re-route detection with a flicker-stability guard: the destination differs from the tracked
  // trip's. Require the NEW dest to hold destStableTicks consecutive ticks before acting on it.
  if (prev && prev.destPortId !== voyage.destPortId) {
    const pendingTicks = prev.pendingDest === voyage.destPortId ? prev.pendingTicks + 1 : 1;
    if (pendingTicks < destStableTicks) {
      return { actions, nextState: { ...prev, pendingDest: voyage.destPortId, pendingTicks } };
    }
    // Stable re-route: abandon the old open trip (never fabricate an arrival), then open the new leg.
    if (prev.tripId != null && prev.status === 'open') actions.push({ type: 'abandon', tripId: prev.tripId, reason: 'reroute' });
    prev = null; // fall through to open-new
  } else if (prev && prev.pendingDest) {
    prev = { ...prev, pendingDest: null, pendingTicks: 0 }; // dest settled back — clear the counter
  }

  // Anchor recovered on the SAME destination within grace: resume the same trip — the stitch that
  // prevents voyage fragmentation. 'resume' is stats-only (the DB row never changed; nothing to write).
  if (prev && prev.anchorLostSince != null) {
    if (prev.tripId != null && prev.status === 'open') actions.push({ type: 'resume', tripId: prev.tripId });
    prev = { ...prev, anchorLostSince: null };
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
        pendingDest: null, pendingTicks: 0, anchorLostSince: null,
      },
    };
  }

  // Existing tracked trip (same dest) — decorate it while it's open and its id is known.
  const next = { ...prev };
  if (prev.tripId != null && prev.status === 'open') {
    if (fresh && now - prev.lastPointTs >= minPointGapMs) {
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

// --- Geofence (CLOSE) side ------------------------------------------------
// The geofence loop's diffMembership yields enter/exit events; these pure helpers turn a tick's
// events into the CLOSE-side work the relay dispatches. Enter at a trip's destination = arrival;
// exits feed origin/dwell backfills. Kept pure + unit-tested alongside the anchor-side decideTrip.

/**
 * Plan the CLOSE-side actions from a tick's geofence events.
 * @param events       [{ mmsi, portId, kind:'enter'|'exit', ts, dwellMin? }]
 * @param tripByMmsi   the relay's live trip map (read-only here)
 * @param skipEnters   cold-boot phantom-enter guard — on the first tick after a boot that restored NO
 *                     membership, every in-zone vessel fires a bogus 'enter'; skip arrivals that tick
 * @returns { arrivals:[{mmsi,portId,ts}], exits:[{mmsi,portId,ts,dwellMin}], arrivedMmsi:[mmsi] }
 *   arrivedMmsi = the subset whose OPEN trip's destination matches the entered port (in-memory flip
 *   to 'arrived', mirroring finishTrip's WHERE join so point capture stops immediately).
 */
function planGeofenceActions(events, tripByMmsi, { skipEnters = false } = {}) {
  const arrivals = [];
  const exits = [];
  const arrivedMmsi = [];
  for (const e of events || []) {
    const mmsi = String(e.mmsi);
    if (e.kind === 'enter') {
      if (skipEnters) continue;
      arrivals.push({ mmsi, portId: e.portId, ts: e.ts });
      const t = tripByMmsi && tripByMmsi.get(mmsi);
      if (t && t.status === 'open' && t.destPortId === e.portId) arrivedMmsi.push(mmsi);
    } else if (e.kind === 'exit') {
      exits.push({ mmsi, portId: e.portId, ts: e.ts, dwellMin: e.dwellMin });
    }
  }
  return { arrivals, exits, arrivedMmsi };
}

/**
 * Decide whether a remembered recent geofence exit is a trip's ORIGIN (the exit-before-open case that
 * backfillTripOrigin can't catch, since no future exit fires). Valid when it's a DIFFERENT port than
 * the destination and lands in a sane window around opened_at. Returns { portId, ts } or null.
 */
function originFromRecentExit(recentExit, destPortId, openedAt, opts = {}) {
  if (!recentExit || !recentExit.portId || recentExit.portId === destPortId) return null;
  const maxBeforeMs = opts.maxBeforeMs ?? 6 * 60 * 60_000; // exit up to 6h before the leg opened
  const maxAfterMs = opts.maxAfterMs ?? 30 * 60_000;       // …or shortly after (open resolved at berth)
  const dt = openedAt - recentExit.ts; // >0 ⇒ exit before open
  if (dt > maxBeforeMs || dt < -maxAfterMs) return null;
  return { portId: recentExit.portId, ts: recentExit.ts };
}

/**
 * In-memory trip gauges for the /health endpoint (sync — no I/O). Counts OPEN trips and the age of
 * the oldest, the direct leak indicator (a healthy fleet's oldest open trip is younger than the
 * abandon cap; a climbing oldest age means trips aren't closing).
 * @returns { openCount, oldestOpenAgeMin } (oldestOpenAgeMin null when nothing is open)
 */
function summarizeTrips(tripByMmsi, now) {
  let openCount = 0;
  let graceCount = 0; // open trips currently riding the anchor-loss grace window
  let oldestOpenedAt = null;
  for (const t of tripByMmsi.values()) {
    if (t.status !== 'open') continue;
    openCount++;
    if (t.anchorLostSince != null) graceCount++;
    if (oldestOpenedAt == null || t.openedAt < oldestOpenedAt) oldestOpenedAt = t.openedAt;
  }
  return { openCount, graceCount, oldestOpenAgeMin: oldestOpenedAt == null ? null : Math.round((now - oldestOpenedAt) / 60_000) };
}

/**
 * Is the trips pipeline degraded? Pure, so the /health verdict is unit-tested rather than asserted
 * inline in the relay. Three independent faults:
 *   1. the last trip write FAILED — the durable store is rejecting us;
 *   2. the point buffer is at high water — we're producing points faster than we can flush them;
 *   3. the oldest open trip is so old that the abandon sweep must have failed to reap it.
 *
 * (3) needs SLACK, and not having it was a false-positive generator. The cap (maxOpenAgeMin) is
 * enforced by a sweep that only runs every sweepIntervalMin, so an open trip can legitimately sit
 * up to one full sweep interval past the cap while simply WAITING for the next sweep. Alarming at
 * the cap itself made "degraded" fire on the relay's own sweep cadence: prod on 2026-07-14 had a
 * standing queue of never-arriving trips (119h, 115h, 96h, 94h, 92h…) feeding into a 120h cap swept
 * once a day, so the flag would flip, hold for up to 24h, then self-clear — repeatedly, while
 * nothing was actually wrong. It also reset the paid-launch gate's clean-week clock each time.
 * Alarm only once the sweep has demonstrably NOT cleared the trip: age > cap + one sweep interval.
 */
function tripsDegraded({ lastTripWriteOk, pointsBuffered, pointsHighWater, oldestOpenAgeMin, maxOpenAgeMin, sweepIntervalMin }) {
  if (lastTripWriteOk === false) return true;
  if ((pointsBuffered ?? 0) >= pointsHighWater) return true;
  if (oldestOpenAgeMin != null && oldestOpenAgeMin > maxOpenAgeMin + sweepIntervalMin) return true;
  return false;
}

module.exports = { decideTrip, planGeofenceActions, originFromRecentExit, summarizeTrips, tripsDegraded, DEFAULTS };
