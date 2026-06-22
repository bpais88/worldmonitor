'use strict';

const { test } = require('node:test');
const { strict: assert } = require('node:assert');

const { recordSnapshot, detectDrift, updateVoyage } = require('./eta-history.cjs');

const MIN = 60_000;
// Build a buffer of snapshots spaced `stepMin` apart, ending at t0.
function series(t0, stepMin, points) {
  // points: [{ etaOffsetMin, dest, speed }] oldest-first
  const n = points.length;
  return points.map((p, i) => ({
    ts: t0 - (n - 1 - i) * stepMin * MIN,
    etaTs: p.etaOffsetMin == null ? null : t0 - (n - 1 - i) * stepMin * MIN + p.etaOffsetMin * MIN,
    destPortId: p.dest ?? 'capri',
    speed: p.speed ?? 20,
  }));
}

const T0 = 1_700_000_000_000;

test('recordSnapshot appends and caps to maxSnapshots', () => {
  let buf = [];
  for (let i = 0; i < 130; i++) buf = recordSnapshot(buf, { ts: T0 + i * MIN, etaTs: T0, destPortId: 'x', speed: 10 });
  assert.equal(buf.length, 120);
  assert.equal(buf[buf.length - 1].ts, T0 + 129 * MIN);
});

test('recordSnapshot drops stale snapshots', () => {
  let buf = [{ ts: T0 - 7 * 3_600_000, etaTs: T0, destPortId: 'x', speed: 10 }];
  buf = recordSnapshot(buf, { ts: T0, etaTs: T0, destPortId: 'x', speed: 10 });
  assert.equal(buf.length, 1); // the 7h-old one is dropped (>6h)
});

test('returns null without enough samples', () => {
  const buf = series(T0, 5, [{ etaOffsetMin: 60 }, { etaOffsetMin: 60 }]);
  assert.equal(detectDrift(buf), null);
});

test('flags slipping when predicted arrival moves later across the window', () => {
  // Time-remaining stays ~60 min while 30 min of wall-clock passes => the vessel
  // makes no real progress, so absolute predicted arrival slips 30 min later.
  const buf = series(T0, 10, [
    { etaOffsetMin: 60 }, { etaOffsetMin: 60 }, { etaOffsetMin: 60 }, { etaOffsetMin: 60 },
  ]);
  const r = detectDrift(buf);
  assert.ok(r && r.slipping, 'should be slipping');
  assert.equal(r.etaGrowthMin, 30);
  assert.ok(r.windowMin >= 10);
});

test('does NOT flag slipping when on a steady, on-time ETA', () => {
  // Healthy crossing: time-remaining shrinks in step with elapsed time, so the
  // absolute predicted arrival stays constant.
  const buf = series(T0, 10, [
    { etaOffsetMin: 60 }, { etaOffsetMin: 50 }, { etaOffsetMin: 40 }, { etaOffsetMin: 30 },
  ]);
  const r = detectDrift(buf);
  assert.ok(r && r.slipping === false);
  assert.equal(r.etaGrowthMin, 0);
});

test('does NOT flag slipping when arrival is moving earlier (speeding up)', () => {
  // Time-remaining shrinks faster than elapsed time => arriving earlier.
  const buf = series(T0, 10, [
    { etaOffsetMin: 90 }, { etaOffsetMin: 60 }, { etaOffsetMin: 30 }, { etaOffsetMin: 0 },
  ]);
  const r = detectDrift(buf);
  assert.ok(r && r.slipping === false);
  assert.equal(r.etaGrowthMin, -60);
});

test('a destination change resets the leg (old slip ignored)', () => {
  const old = series(T0 - 40 * MIN, 10, [
    { etaOffsetMin: 60, dest: 'ponza' }, { etaOffsetMin: 60, dest: 'ponza' },
  ]);
  // Fresh 'capri' leg is steady (time-remaining shrinks with elapsed time).
  const fresh = series(T0, 5, [
    { etaOffsetMin: 50, dest: 'capri' }, { etaOffsetMin: 45, dest: 'capri' }, { etaOffsetMin: 40, dest: 'capri' },
  ]);
  const r = detectDrift([...old, ...fresh]);
  // Only the steady 'capri' leg counts -> not slipping.
  assert.ok(r && r.slipping === false);
});

test('flags stalled when stopped mid-crossing after moving', () => {
  const buf = series(T0, 10, [
    { etaOffsetMin: 60, speed: 18 }, { etaOffsetMin: 70, speed: 12 }, { etaOffsetMin: null, speed: 0.1 },
  ]);
  const r = detectDrift(buf);
  assert.ok(r && r.stalled, 'should be stalled');
});

test('does NOT flag stalled when stopped with no destination (in port)', () => {
  const buf = series(T0, 10, [
    { etaOffsetMin: null, dest: '', speed: 0 }, { etaOffsetMin: null, dest: '', speed: 0 }, { etaOffsetMin: null, dest: '', speed: 0 },
  ]);
  assert.equal(detectDrift(buf), null);
});

test('updateVoyage: opens a trip, keeps it, and resets on destination change', () => {
  // No destination → no voyage.
  assert.equal(updateVoyage(null, { destPortId: '', etaTs: null, now: T0 }), null);
  // First sight with a destination → opens an anchor stamped now.
  const v1 = updateVoyage(null, { destPortId: 'olbia', etaTs: T0 + 5 * 3_600_000, now: T0 });
  assert.equal(v1.destPortId, 'olbia');
  assert.equal(v1.startTs, T0);
  assert.equal(v1.departureEtaTs, T0 + 5 * 3_600_000);
  // Same destination later → SAME anchor (startTs unchanged → "vs departure" holds).
  const v2 = updateVoyage(v1, { destPortId: 'olbia', etaTs: T0 + 6 * 3_600_000, now: T0 + 3_600_000 });
  assert.equal(v2.startTs, T0);
  assert.equal(v2.departureEtaTs, v1.departureEtaTs);
  // Destination change → NEW trip (new startTs).
  const v3 = updateVoyage(v2, { destPortId: 'genoa', etaTs: T0 + 8 * 3_600_000, now: T0 + 4 * 3_600_000 });
  assert.equal(v3.destPortId, 'genoa');
  assert.equal(v3.startTs, T0 + 4 * 3_600_000);
});

test('updateVoyage: backfills departure ETA once the vessel starts moving', () => {
  // Opened while stopped at the dock (no ETA yet).
  const v1 = updateVoyage(null, { destPortId: 'capri', etaTs: null, now: T0 });
  assert.equal(v1.departureEtaTs, null);
  // First real ETA backfills the departure baseline (startTs stays).
  const v2 = updateVoyage(v1, { destPortId: 'capri', etaTs: T0 + 2 * 3_600_000, now: T0 + 600_000 });
  assert.equal(v2.startTs, T0);
  assert.equal(v2.departureEtaTs, T0 + 2 * 3_600_000);
});
