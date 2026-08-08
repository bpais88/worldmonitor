'use strict';

// Phase B trips lifecycle, exercised through the REAL relay wiring rather than the pure module.
//
// trip-lifecycle.test.cjs already covers decideTrip/planGeofenceActions as pure functions. What was
// never covered — and what actually broke in the extraction — is the WIRING: does the relay call
// them at the right moment, with the right state, and dispatch the resulting actions to the right
// db calls. So db.cjs is stubbed and we assert on the calls the relay makes.

process.env.RELAY_SHARED_SECRET = 'trips-secret';
process.env.AISSTREAM_API_KEY = '';
process.env.MARINESIA_API_KEY = '';
process.env.TRIPS_ENABLED = '1';
process.env.TRIP_ANCHOR_GRACE_MIN = '0';   // abandon immediately on anchor loss, no waiting in tests
process.env.TRIP_BOOT_GRACE_TICKS = '1';

const { test, beforeEach } = require('node:test');
const { strict: assert } = require('node:assert');

// Stub the durable store BEFORE relay.cjs requires it, so `db.enabled` is true without Postgres.
const db = require('./db.cjs');
const calls = [];
const record = (name) => (...args) => { calls.push({ name, args }); return Promise.resolve(name === 'openTrip' ? 42 : []); };
Object.defineProperty(db, 'enabled', { value: true, configurable: true });
for (const fn of ['openTrip', 'finishTrip', 'appendTripPoints', 'abandonTrips', 'markStalled',
  'patchTripEta', 'bumpTripEtaSlip', 'backfillTripOrigin', 'backfillDestDwell', 'finalizeArrivedGeo',
  'abandonStaleTrips', 'pruneTripPoints', 'writeEvents', 'writeSnapshot', 'syncPorts',
  'refreshBaselines', 'loadBaselines']) {
  db[fn] = record(fn);
}
db.loadOpenTrips = async () => ({ trips: new Map(), capped: false });
db.loadBaselines = async () => new Map();

const { createRelay } = require('./relay.cjs');

const GENOA = { lat: 44.41, lon: 8.9 };
const called = (name) => calls.filter((c) => c.name === name);

function underway(mmsi, over = {}) {
  return {
    mmsi, name: 'EVER TRIP', shipType: 70, lat: 43.0, lon: 8.0,
    speed: 14, destination: 'ITGOA', timestamp: Date.now(), ...over,
  };
}

let relay;
beforeEach(async () => {
  calls.length = 0;
  if (relay) relay.stop();
  relay = createRelay({ startIngest: false, startJobs: false });
  relay.state.trips.ready = true;      // normally set by resumeTrips(); no Postgres here
  relay.state.lastAisFrameAt = Date.now(); // pretend aisstream is live, else every zone is frozen
                                           // as an honest blind spot and no geofence event fires
});

test('a freight vessel under way to a tracked port opens a trip', () => {
  const { state } = relay;
  state.store.applyFull(underway('900000001'));
  relay.delayTick(state);

  const opens = called('openTrip');
  assert.equal(opens.length, 1, 'exactly one trip opened');
  assert.equal(opens[0].args[0].mmsi, '900000001');
  assert.equal(opens[0].args[0].destPortId, 'genoa');
  assert.ok(state.trips.byMmsi.has('900000001'), 'trip tracked in memory');
});

test('the openTrip id is bound back onto the in-memory trip', async () => {
  const { state } = relay;
  state.store.applyFull(underway('900000002'));
  relay.delayTick(state);
  await new Promise((r) => setImmediate(r)); // let the openTrip promise settle
  assert.equal(state.trips.byMmsi.get('900000002').tripId, 42);
});

test('a second tick on the same voyage does NOT open a duplicate trip', () => {
  const { state } = relay;
  state.store.applyFull(underway('900000003'));
  relay.delayTick(state);
  relay.delayTick(state);
  assert.equal(called('openTrip').length, 1, 'one voyage, one trip row');
});

test('losing the destination anchor abandons the open trip (grace = 0 here)', async () => {
  const { state } = relay;
  state.store.applyFull(underway('900000004'));
  relay.delayTick(state);
  await new Promise((r) => setImmediate(r));

  // Destination cleared — the crew garbled or blanked the AIS dest string.
  state.store.applyFull(underway('900000004', { destination: '' }));
  relay.delayTick(state); // tickCount 2 > bootGraceTicks 1 -> reconciliation runs

  const abandons = called('abandonTrips');
  assert.equal(abandons.length, 1);
  assert.deepEqual(abandons[0].args[0], [42]);
  assert.equal(abandons[0].args[1], 'anchor_lost');
  assert.equal(state.trips.byMmsi.has('900000004'), false, 'forgotten in memory too');
});

test('boot grace defers anchor-loss reconciliation (a seeded trip is not abandoned instantly)', () => {
  const { state } = relay;
  state.trips.byMmsi.set('900000005', {
    tripId: 7, destPortId: 'genoa', openedAt: Date.now() - 60_000, status: 'open',
    lastPointTs: 0, stalledMarked: false, etaPatched: false,
    pendingDest: null, pendingTicks: 0, anchorLostSince: null,
  });
  relay.delayTick(state); // tickCount 1, NOT > bootGraceTicks 1 -> skipped
  assert.equal(called('abandonTrips').length, 0, 'no abandon during boot grace');
  assert.ok(state.trips.byMmsi.has('900000005'));
});

test('arriving at the destination closes the trip and marks it arrived', () => {
  const { state } = relay;
  state.trips.skipFirstEnters = false; // past the cold-boot tick
  state.trips.byMmsi.set('900000006', {
    tripId: 11, destPortId: 'genoa', openedAt: Date.now() - 3600_000, status: 'open',
    lastPointTs: 0, stalledMarked: false, etaPatched: false,
    pendingDest: null, pendingTicks: 0, anchorLostSince: null,
  });
  // Moored inside Genoa's zone -> a geofence ENTER on the next tick.
  state.store.applyFull(underway('900000006', { ...GENOA, speed: 0, navStatus: 5 }));
  relay.geofenceTick(state);

  assert.equal(called('finishTrip').length, 1, 'trip finished on destination arrival');
  assert.equal(state.trips.byMmsi.get('900000006').status, 'arrived');
});

test('SECURITY-OF-DATA: the cold-boot tick does not invent arrivals for vessels already in a zone', () => {
  const { state } = relay;
  assert.equal(state.trips.skipFirstEnters, true, 'guard armed at boot');
  state.trips.byMmsi.set('900000007', {
    tripId: 12, destPortId: 'genoa', openedAt: Date.now() - 3600_000, status: 'open',
    lastPointTs: 0, stalledMarked: false, etaPatched: false,
    pendingDest: null, pendingTicks: 0, anchorLostSince: null,
  });
  state.store.applyFull(underway('900000007', { ...GENOA, speed: 0, navStatus: 5 }));
  relay.geofenceTick(state); // first tick: every in-zone vessel diffs as a fresh enter

  assert.equal(called('finishTrip').length, 0, 'a restart must not close trips that never arrived');
  assert.equal(state.trips.byMmsi.get('900000007').status, 'open');
  assert.equal(state.trips.skipFirstEnters, false, 'guard consumed after one tick');
});

test('trip points buffer, flush in one batch, and are capped rather than growing unbounded', async () => {
  const { state } = relay;
  state.store.applyFull(underway('900000008'));
  relay.delayTick(state);                 // opens; tripId still null (insert in flight)
  await new Promise((r) => setImmediate(r));
  state.store.applyFull(underway('900000008', { lat: 43.5 }));
  relay.delayTick(state);                 // now the trip has an id -> the trail starts
  assert.ok(state.trips.pendingPoints.length >= 1, 'a point is captured once the trip has an id');

  await relay.flushTripPoints(state);
  assert.equal(called('appendTripPoints').length, 1, 'one batched write, not one per point');
  assert.equal(state.trips.pendingPoints.length, 0, 'buffer drained');

  // Overflow far past the cap; the oldest must be dropped, and the drop counted.
  const before = db.stats.tripPointsDropped || 0;
  for (let i = 0; i < 6000; i++) state.trips.pendingPoints.push({ tripId: 1, ts: i });
  relay.capTripPoints(state);
  assert.ok(state.trips.pendingPoints.length <= 5000, 'buffer capped');
  assert.ok((db.stats.tripPointsDropped || 0) > before, 'drops are counted, not silent');
});

test('/health trips reports the live pipeline, not a placeholder', async () => {
  const { state } = relay;
  state.store.applyFull(underway('900000009'));
  relay.delayTick(state);                  // open (no id yet -> no point)
  await new Promise((r) => setImmediate(r));
  state.store.applyFull(underway('900000009', { lat: 43.5 }));
  relay.delayTick(state);                  // id bound -> the trail starts

  const h = relay.buildTripsHealth(state);
  assert.equal(h.enabled, true);
  assert.equal(h.notPorted, undefined, 'the not-ported marker is gone now that it IS ported');
  assert.equal(h.openTripsTracked, 1);
  assert.equal(h.degraded, false);
  assert.ok(h.tripPointsBuffered >= 1);
  // ops-report.mjs renders these directly; absent keys print "undefined" in Slack.
  for (const k of ['openTripsInGrace', 'tripsResumed', 'oldestOpenTripAgeMin', 'recentExitsTracked',
    'tripsOpened', 'tripsArrived', 'tripsAbandoned', 'lastTripWriteOk', 'maxOpenAgeMin', 'sweepIntervalMin']) {
    assert.ok(k in h, `trips health missing "${k}"`);
  }
});

test('an exit is remembered so a trip opened just after departure still gets its origin', () => {
  const { state } = relay;
  state.trips.skipFirstEnters = false;
  // Vessel sits in Genoa, then leaves: enter (tick 1) then exit (tick 2).
  state.store.applyFull(underway('900000010', { ...GENOA, speed: 0, navStatus: 5 }));
  relay.geofenceTick(state);
  state.store.applyFull(underway('900000010', { lat: 42.0, lon: 7.0, speed: 12 }));
  relay.geofenceTick(state);

  assert.equal(called('backfillTripOrigin').length, 1, 'exit backfills origin');
  assert.equal(called('backfillDestDwell').length, 1, 'exit backfills dwell');
  assert.ok(state.trips.recentExitByMmsi.has('900000010'), 'exit remembered for exit-before-open');
});

// ---- read-only mode (cutover safety: a second relay against PRODUCTION Postgres) ----

test('SECURITY-OF-DATA: read-only mode serves everything and writes nothing', async () => {
  // The parity gate needs the new relay live alongside the old one, both pointed at the same
  // database. Without this, the second relay double-writes snapshots and geofence events and
  // races the unique-open-trip constraint — corrupting the very history we are trying to keep.
  const path = require.resolve('./relay.cjs');
  delete require.cache[path];
  process.env.RELAY_READ_ONLY = '1';
  const ro = require('./relay.cjs');
  try {
    assert.equal(ro.CONFIG.readOnly, true);
    assert.equal(ro.canWrite(), false, 'db.enabled is true here, yet writes must be refused');

    calls.length = 0;
    const r = ro.createRelay({ startIngest: false, startJobs: false });
    r.state.trips.ready = true;
    r.state.lastAisFrameAt = Date.now();
    r.state.store.applyFull(underway('900000099'));
    r.delayTick(r.state);
    r.geofenceTick(r.state);

    for (const w of ['openTrip', 'appendTripPoints', 'writeSnapshot', 'writeEvents',
      'finishTrip', 'abandonTrips', 'syncPorts', 'refreshBaselines']) {
      assert.equal(called(w).length, 0, `read-only must not call db.${w}`);
    }
    // ...but the data still SERVES, or the parity run would compare against an empty relay.
    const ports = r.state.portHistory.snapshots;
    assert.ok(Array.isArray(ports), 'in-memory history still accumulates for reads');
    r.stop();
  } finally {
    delete process.env.RELAY_READ_ONLY;
    delete require.cache[path];
    require('./relay.cjs'); // restore the normal-mode module for any later test
  }
});
