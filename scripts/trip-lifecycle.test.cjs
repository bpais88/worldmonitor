'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { decideTrip, planGeofenceActions, originFromRecentExit, summarizeTrips, DEFAULTS } = require('./trip-lifecycle.cjs');

const T0 = 1_700_000_000_000;
const MIN = 60_000;
const voyage = (destPortId, startTs = T0, departureEtaTs = null) => ({ destPortId, startTs, departureEtaTs });
const types = (actions) => actions.map((a) => a.type);

test('opens a new trip when nothing is tracked', () => {
  const { actions, nextState } = decideTrip(null, voyage('ancona', T0, T0 + 6 * 60 * MIN), { now: T0, fresh: true });
  assert.deepStrictEqual(types(actions), ['open']);
  assert.strictEqual(actions[0].destPortId, 'ancona');
  assert.strictEqual(actions[0].openedAt, T0);
  assert.strictEqual(actions[0].departureEta, T0 + 6 * 60 * MIN);
  assert.strictEqual(nextState.tripId, null);
  assert.strictEqual(nextState.status, 'open');
  assert.strictEqual(nextState.etaPatched, true); // departureEta known at open
});

test('open trip has etaPatched=false when no departure ETA yet', () => {
  const { nextState } = decideTrip(null, voyage('ancona', T0, null), { now: T0, fresh: true });
  assert.strictEqual(nextState.etaPatched, false);
});

test('no voyage abandons an open tracked trip and clears state', () => {
  const prev = { tripId: 5, destPortId: 'ancona', openedAt: T0, status: 'open', lastPointTs: 0, stalledMarked: false, etaPatched: true, pendingDest: null, pendingTicks: 0 };
  const { actions, nextState } = decideTrip(prev, null, { now: T0 + MIN });
  assert.deepStrictEqual(types(actions), ['abandon']);
  assert.strictEqual(actions[0].tripId, 5);
  assert.strictEqual(nextState, null);
});

test('no voyage with no tracked trip is a clean no-op', () => {
  const { actions, nextState } = decideTrip(undefined, null, { now: T0 });
  assert.deepStrictEqual(actions, []);
  assert.strictEqual(nextState, null);
});

test('captures a point once the gap has elapsed, not before', () => {
  const base = { tripId: 9, destPortId: 'ancona', openedAt: T0, status: 'open', lastPointTs: T0, stalledMarked: false, etaPatched: true, pendingDest: null, pendingTicks: 0 };
  // 4 min later: below the 5-min gap → no capture
  let r = decideTrip(base, voyage('ancona', T0), { now: T0 + 4 * MIN, fresh: true });
  assert.ok(!types(r.actions).includes('capturePoint'));
  assert.strictEqual(r.nextState.lastPointTs, T0);
  // 5 min later: capture
  r = decideTrip(base, voyage('ancona', T0), { now: T0 + 5 * MIN, fresh: true });
  assert.deepStrictEqual(types(r.actions), ['capturePoint']);
  assert.strictEqual(r.actions[0].tripId, 9);
  assert.strictEqual(r.nextState.lastPointTs, T0 + 5 * MIN);
});

test('does not capture a point from a stale position', () => {
  const prev = { tripId: 9, destPortId: 'ancona', openedAt: T0, status: 'open', lastPointTs: 0, stalledMarked: false, etaPatched: true, pendingDest: null, pendingTicks: 0 };
  const r = decideTrip(prev, voyage('ancona', T0), { now: T0 + 60 * MIN, fresh: false });
  assert.ok(!types(r.actions).includes('capturePoint'));
});

test('does not decorate a trip whose id has not resolved yet', () => {
  const prev = { tripId: null, destPortId: 'ancona', openedAt: T0, status: 'open', lastPointTs: 0, stalledMarked: false, etaPatched: false, pendingDest: null, pendingTicks: 0 };
  const r = decideTrip(prev, voyage('ancona', T0, T0 + MIN), { now: T0 + 60 * MIN, fresh: true, speedStalled: true, etaSlipMin: 30 });
  assert.deepStrictEqual(r.actions, []); // no capture/stall/patch/bump until tripId is known
});

test('does not decorate a trip that has already arrived', () => {
  const prev = { tripId: 9, destPortId: 'ancona', openedAt: T0, status: 'arrived', lastPointTs: 0, stalledMarked: false, etaPatched: true, pendingDest: null, pendingTicks: 0 };
  const r = decideTrip(prev, voyage('ancona', T0), { now: T0 + 60 * MIN, fresh: true, speedStalled: true });
  assert.deepStrictEqual(r.actions, []);
});

test('marks stalled once (eager), then never again', () => {
  const prev = { tripId: 9, destPortId: 'ancona', openedAt: T0, status: 'open', lastPointTs: T0, stalledMarked: false, etaPatched: true, pendingDest: null, pendingTicks: 0 };
  let r = decideTrip(prev, voyage('ancona', T0), { now: T0 + MIN, fresh: false, speedStalled: true });
  assert.ok(types(r.actions).includes('markStalled'));
  assert.strictEqual(r.nextState.stalledMarked, true);
  r = decideTrip(r.nextState, voyage('ancona', T0), { now: T0 + 2 * MIN, fresh: false, speedStalled: true });
  assert.ok(!types(r.actions).includes('markStalled'));
});

test('patches departure ETA once when the anchor first gets a real ETA', () => {
  const prev = { tripId: 9, destPortId: 'ancona', openedAt: T0, status: 'open', lastPointTs: T0, stalledMarked: false, etaPatched: false, pendingDest: null, pendingTicks: 0 };
  let r = decideTrip(prev, voyage('ancona', T0, T0 + 3 * 60 * MIN), { now: T0 + MIN, fresh: false });
  const patch = r.actions.find((a) => a.type === 'patchEta');
  assert.ok(patch && patch.etaTs === T0 + 3 * 60 * MIN);
  assert.strictEqual(r.nextState.etaPatched, true);
  r = decideTrip(r.nextState, voyage('ancona', T0, T0 + 9 * 60 * MIN), { now: T0 + 2 * MIN, fresh: false });
  assert.ok(!types(r.actions).includes('patchEta'));
});

test('bumps ETA slip only when positive', () => {
  const prev = { tripId: 9, destPortId: 'ancona', openedAt: T0, status: 'open', lastPointTs: T0, stalledMarked: false, etaPatched: true, pendingDest: null, pendingTicks: 0 };
  let r = decideTrip(prev, voyage('ancona', T0), { now: T0 + MIN, fresh: false, etaSlipMin: 18 });
  const bump = r.actions.find((a) => a.type === 'bumpSlip');
  assert.ok(bump && bump.slipMin === 18);
  r = decideTrip(prev, voyage('ancona', T0), { now: T0 + MIN, fresh: false, etaSlipMin: -5 });
  assert.ok(!types(r.actions).includes('bumpSlip'));
});

test('re-route flicker: below the stability threshold does nothing but count', () => {
  const prev = { tripId: 9, destPortId: 'ancona', openedAt: T0, status: 'open', lastPointTs: T0, stalledMarked: false, etaPatched: true, pendingDest: null, pendingTicks: 0 };
  const r = decideTrip(prev, voyage('genova', T0 + MIN), { now: T0 + MIN, fresh: true }); // destStableTicks=2, first tick
  assert.deepStrictEqual(r.actions, []);
  assert.strictEqual(r.nextState.destPortId, 'ancona'); // old trip untouched
  assert.strictEqual(r.nextState.pendingDest, 'genova');
  assert.strictEqual(r.nextState.pendingTicks, 1);
});

test('re-route: once the new dest holds destStableTicks, abandon old + open new', () => {
  let prev = { tripId: 9, destPortId: 'ancona', openedAt: T0, status: 'open', lastPointTs: T0, stalledMarked: false, etaPatched: true, pendingDest: null, pendingTicks: 0 };
  let r = decideTrip(prev, voyage('genova', T0 + MIN), { now: T0 + MIN, fresh: true }); // tick 1: pending
  r = decideTrip(r.nextState, voyage('genova', T0 + MIN), { now: T0 + 2 * MIN, fresh: true }); // tick 2: act
  assert.deepStrictEqual(types(r.actions), ['abandon', 'open']);
  assert.strictEqual(r.actions[0].tripId, 9);
  assert.strictEqual(r.actions[1].destPortId, 'genova');
  assert.strictEqual(r.nextState.destPortId, 'genova');
  assert.strictEqual(r.nextState.tripId, null);
});

test('re-route flicker that settles back to the original dest clears the counter', () => {
  let prev = { tripId: 9, destPortId: 'ancona', openedAt: T0, status: 'open', lastPointTs: T0, stalledMarked: false, etaPatched: true, pendingDest: null, pendingTicks: 0 };
  let r = decideTrip(prev, voyage('genova', T0 + MIN), { now: T0 + MIN, fresh: true }); // flicker to genova
  assert.strictEqual(r.nextState.pendingDest, 'genova');
  r = decideTrip(r.nextState, voyage('ancona', T0), { now: T0 + 2 * MIN, fresh: false }); // back to ancona
  assert.strictEqual(r.nextState.pendingDest, null);
  assert.strictEqual(r.nextState.pendingTicks, 0);
  assert.strictEqual(r.nextState.destPortId, 'ancona');
});

test('custom destStableTicks=1 acts on the first re-route tick', () => {
  const prev = { tripId: 9, destPortId: 'ancona', openedAt: T0, status: 'open', lastPointTs: T0, stalledMarked: false, etaPatched: true, pendingDest: null, pendingTicks: 0 };
  const r = decideTrip(prev, voyage('genova', T0 + MIN), { now: T0 + MIN, fresh: true, opts: { destStableTicks: 1 } });
  assert.deepStrictEqual(types(r.actions), ['abandon', 'open']);
});

test('DEFAULTS are exposed and sane', () => {
  assert.strictEqual(DEFAULTS.minPointGapMs, 5 * 60_000);
  assert.strictEqual(DEFAULTS.destStableTicks, 2);
});

// --- planGeofenceActions (CLOSE side) --------------------------------------

const openTrip = (destPortId) => ({ tripId: 1, destPortId, openedAt: T0, status: 'open', lastPointTs: 0, stalledMarked: false, etaPatched: true, pendingDest: null, pendingTicks: 0 });

test('enter at a trip destination is an arrival + flags the mmsi for in-memory close', () => {
  const trips = new Map([['247', openTrip('ancona')]]);
  const events = [{ mmsi: '247', portId: 'ancona', kind: 'enter', ts: T0 }];
  const { arrivals, exits, arrivedMmsi } = planGeofenceActions(events, trips);
  assert.deepStrictEqual(arrivals, [{ mmsi: '247', portId: 'ancona', ts: T0 }]);
  assert.deepStrictEqual(arrivedMmsi, ['247']);
  assert.deepStrictEqual(exits, []);
});

test('enter at a port that is not the open trip destination is still an arrival but not an in-memory close', () => {
  const trips = new Map([['247', openTrip('genova')]]); // open trip goes to genova, entered ancona
  const { arrivals, arrivedMmsi } = planGeofenceActions([{ mmsi: '247', portId: 'ancona', kind: 'enter', ts: T0 }], trips);
  assert.strictEqual(arrivals.length, 1);         // finishTrip's WHERE join will simply match 0 rows
  assert.deepStrictEqual(arrivedMmsi, []);        // don't flip the genova trip to arrived
});

test('skipEnters (cold-boot phantom guard) drops all enters, keeps exits', () => {
  const events = [
    { mmsi: '1', portId: 'ancona', kind: 'enter', ts: T0 },
    { mmsi: '2', portId: 'genova', kind: 'exit', ts: T0, dwellMin: 40 },
  ];
  const { arrivals, exits, arrivedMmsi } = planGeofenceActions(events, new Map(), { skipEnters: true });
  assert.deepStrictEqual(arrivals, []);
  assert.deepStrictEqual(arrivedMmsi, []);
  assert.deepStrictEqual(exits, [{ mmsi: '2', portId: 'genova', ts: T0, dwellMin: 40 }]);
});

test('exit carries dwellMin through for the dest-dwell backfill', () => {
  const { exits } = planGeofenceActions([{ mmsi: '5', portId: 'napoli', kind: 'exit', ts: T0, dwellMin: 63 }], new Map());
  assert.deepStrictEqual(exits, [{ mmsi: '5', portId: 'napoli', ts: T0, dwellMin: 63 }]);
});

test('planGeofenceActions tolerates empty/absent inputs', () => {
  const r = planGeofenceActions(undefined, undefined);
  assert.deepStrictEqual(r, { arrivals: [], exits: [], arrivedMmsi: [] });
});

// --- originFromRecentExit ---------------------------------------------------

test('recent exit before open at a different port is the origin', () => {
  const r = originFromRecentExit({ portId: 'genova', ts: T0 - 20 * MIN }, 'ancona', T0);
  assert.deepStrictEqual(r, { portId: 'genova', ts: T0 - 20 * MIN });
});

test('an exit at the destination itself is never the origin', () => {
  assert.strictEqual(originFromRecentExit({ portId: 'ancona', ts: T0 - 5 * MIN }, 'ancona', T0), null);
});

test('an exit too far before the open is rejected', () => {
  assert.strictEqual(originFromRecentExit({ portId: 'genova', ts: T0 - 7 * 60 * MIN }, 'ancona', T0), null); // >6h before
});

test('an exit shortly after the open (dest resolved at berth) still counts', () => {
  const r = originFromRecentExit({ portId: 'genova', ts: T0 + 10 * MIN }, 'ancona', T0);
  assert.deepStrictEqual(r, { portId: 'genova', ts: T0 + 10 * MIN });
});

test('an exit long after the open is rejected', () => {
  assert.strictEqual(originFromRecentExit({ portId: 'genova', ts: T0 + 40 * MIN }, 'ancona', T0), null); // >30min after
});

test('null recent exit yields null origin', () => {
  assert.strictEqual(originFromRecentExit(null, 'ancona', T0), null);
});

// --- summarizeTrips (/health gauges) ---------------------------------------

test('summarizeTrips counts open trips and the oldest open age, ignoring arrived', () => {
  const m = new Map([
    ['1', { status: 'open', openedAt: T0 - 30 * MIN }],
    ['2', { status: 'open', openedAt: T0 - 90 * MIN }],   // oldest
    ['3', { status: 'arrived', openedAt: T0 - 500 * MIN }], // ignored (not open)
  ]);
  const g = summarizeTrips(m, T0);
  assert.strictEqual(g.openCount, 2);
  assert.strictEqual(g.oldestOpenAgeMin, 90);
});

test('summarizeTrips with no open trips reports null oldest age', () => {
  const m = new Map([['3', { status: 'arrived', openedAt: T0 - 500 * MIN }]]);
  assert.deepStrictEqual(summarizeTrips(m, T0), { openCount: 0, oldestOpenAgeMin: null });
});

test('summarizeTrips on an empty map is zero/null', () => {
  assert.deepStrictEqual(summarizeTrips(new Map(), T0), { openCount: 0, oldestOpenAgeMin: null });
});
