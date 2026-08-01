'use strict';

const { test } = require('node:test');
const { strict: assert } = require('node:assert');
const {
  buildPortGeofences,
  pointInRing,
  isInside,
  computeMembership,
  diffMembership,
} = require('./geofence-engine.cjs');

const PORTS = [
  { id: 'rotterdam', name: 'Rotterdam', lat: 51.95, lon: 4.14, commercial: true },
  { id: 'genoa', name: 'Genoa', lat: 44.41, lon: 8.9, commercial: true },
  { id: 'capri', name: 'Capri', lat: 40.55, lon: 14.24 }, // not commercial → excluded
  { id: 'bad', name: 'Bad', lat: NaN, lon: 8.0, commercial: true }, // invalid coords → excluded
];

test('buildPortGeofences seeds one circle per commercial port with valid coords', () => {
  const gfs = buildPortGeofences(PORTS);
  assert.equal(gfs.length, 2); // rotterdam + genoa (capri not commercial, bad has NaN)
  const rtm = gfs.find((g) => g.portId === 'rotterdam');
  assert.equal(rtm.id, 'rotterdam-port');
  assert.equal(rtm.kind, 'port');
  assert.equal(rtm.geometry.type, 'circle');
  assert.deepEqual(rtm.geometry.center, { lat: 51.95, lon: 4.14 });
  assert.equal(rtm.geometry.radiusKm, 8); // no per-port radiusKm on this fixture → fleet default
  assert.deepEqual(rtm.rules.events, ['enter', 'exit', 'dwell']);
  assert.equal(rtm.rules.appliesTo, 'freight');
  assert.equal(rtm.enabled, true);
  assert.equal(rtm.updatedBy, 'system');
});

// --- One circle, two consumers ------------------------------------------------------------------
// A port geofence and that port's congestion count MUST describe the same disc. They are computed
// in different modules for different purposes — geofences drive enter/exit/dwell (arrivals, trips,
// the forecast's fuel), port-status drives the atPort count — and the only thing that kept them
// aligned used to be a duplicated `8` and a comment saying "kept in sync". The moment port rows
// gained their own `radiusKm`, that comment was the only thing still true: Rotterdam counted to
// 20 km while its geofence fired at 8. These tests make the agreement mechanical.
const { radiusFor, DEFAULTS: PORT_STATUS_DEFAULTS } = require('./port-status.cjs');
const { haversineKm } = require('./ferry-eta.cjs');
const REGISTRY = require('../src/config/maritime-ports.data.json').ports.filter((p) => p.commercial);

test('a port geofence uses THAT port\'s at-port radius, not the fleet default', () => {
  const gfs = buildPortGeofences([
    { id: 'wide', name: 'Wide', lat: 51.95, lon: 4.14, commercial: true, radiusKm: 20 },
    { id: 'tight', name: 'Tight', lat: 45.44, lon: 12.34, commercial: true, radiusKm: 2.5 },
    { id: 'plain', name: 'Plain', lat: 44.41, lon: 8.9, commercial: true },
    { id: 'bogus', name: 'Bogus', lat: 40.84, lon: 14.26, commercial: true, radiusKm: 'wide' },
  ]);
  const r = (id) => gfs.find((g) => g.portId === id).geometry.radiusKm;
  assert.equal(r('wide'), 20);
  assert.equal(r('tight'), 2.5);
  assert.equal(r('plain'), PORT_STATUS_DEFAULTS.radiusKm);
  assert.equal(r('bogus'), PORT_STATUS_DEFAULTS.radiusKm); // unusable value → default, never 0/NaN
});

test('opts.radiusKm moves the DEFAULT only — a port\'s own radius still wins', () => {
  const gfs = buildPortGeofences([
    { id: 'own', name: 'Own', lat: 51.95, lon: 4.14, commercial: true, radiusKm: 20 },
    { id: 'none', name: 'None', lat: 44.41, lon: 8.9, commercial: true },
  ], { radiusKm: 5 });
  assert.equal(gfs.find((g) => g.portId === 'own').geometry.radiusKm, 20);
  assert.equal(gfs.find((g) => g.portId === 'none').geometry.radiusKm, 5);
});

test('every real port geofence matches its port-status disc exactly', () => {
  for (const g of buildPortGeofences(REGISTRY)) {
    const p = REGISTRY.find((x) => x.id === g.portId);
    assert.equal(g.geometry.radiusKm, radiusFor(p, PORT_STATUS_DEFAULTS),
      `${p.id}: geofence radius ${g.geometry.radiusKm}km != at-port radius ${radiusFor(p, PORT_STATUS_DEFAULTS)}km — ` +
        'arrivals/dwell and the congestion count would describe different circles for this port.');
  }
});

test('no two port geofences overlap', () => {
  // The mirror of port-status.test.cjs\'s non-overlap invariant, enforced on the geometry actually
  // served at /ais/geofences. Without it the four sub-16km pairs (Savona/Vado Ligure, Venezia/Porto
  // Marghera, London Gateway/Tilbury, Immingham/Hull) kept double-counting here after port-status
  // stopped — one vessel raising an enter event at two ports.
  const gfs = buildPortGeofences(REGISTRY);
  for (let i = 0; i < gfs.length; i++) {
    for (let j = i + 1; j < gfs.length; j++) {
      const a = gfs[i], b = gfs[j];
      const gap = haversineKm(a.geometry.center, b.geometry.center);
      assert.ok(a.geometry.radiusKm + b.geometry.radiusKm <= gap,
        `${a.portId} (r=${a.geometry.radiusKm}km) and ${b.portId} (r=${b.geometry.radiusKm}km) are ` +
          `${gap.toFixed(1)}km apart — their zones overlap, so one vessel enters both.`);
    }
  }
});

test('pointInRing: inside vs outside a square', () => {
  const square = [
    { lat: 0, lon: 0 }, { lat: 0, lon: 2 }, { lat: 2, lon: 2 }, { lat: 2, lon: 0 },
  ];
  assert.equal(pointInRing(1, 1, square), true);
  assert.equal(pointInRing(3, 1, square), false);
  assert.equal(pointInRing(1, 3, square), false);
  assert.equal(pointInRing(1, 1, [{ lat: 0, lon: 0 }]), false); // degenerate ring
});

test('isInside: circle radius, polygon, disabled + invalid guards', () => {
  const circle = { geometry: { type: 'circle', center: { lat: 51.95, lon: 4.14 }, radiusKm: 8 }, enabled: true };
  assert.equal(isInside(51.95, 4.14, circle), true); // dead centre
  assert.equal(isInside(51.98, 4.18, circle), true); // ~4 km away
  assert.equal(isInside(52.20, 4.14, circle), false); // ~28 km north
  assert.equal(isInside(NaN, 4.14, circle), false);
  assert.equal(isInside(51.95, 4.14, { ...circle, enabled: false }), false);

  const poly = {
    enabled: true,
    geometry: { type: 'polygon', ring: [{ lat: 0, lon: 0 }, { lat: 0, lon: 2 }, { lat: 2, lon: 2 }, { lat: 2, lon: 0 }] },
  };
  assert.equal(isInside(1, 1, poly), true);
  assert.equal(isInside(5, 5, poly), false);
});

test('computeMembership buckets vessels into the zones that contain them', () => {
  const gfs = buildPortGeofences(PORTS);
  const vessels = [
    { mmsi: 'A', lat: 51.95, lon: 4.14 }, // in rotterdam
    { mmsi: 'B', lat: 51.96, lon: 4.16 }, // in rotterdam
    { mmsi: 'C', lat: 44.41, lon: 8.9 },  // in genoa
    { mmsi: 'D', lat: 10.0, lon: 10.0 },  // in neither
    { mmsi: 'E', lat: NaN, lon: 4.14 },   // invalid → skipped
  ];
  const m = computeMembership(vessels, gfs);
  assert.deepEqual([...m.get('rotterdam-port')].sort(), ['A', 'B']);
  assert.deepEqual([...m.get('genoa-port')], ['C']);
});

test('diffMembership emits enter/exit events and computes dwell on exit', () => {
  const gfs = buildPortGeofences(PORTS);
  const enterTimes = new Map();
  const t0 = 1_000_000_000_000;

  // Tick 1: A and C arrive.
  const m1 = computeMembership(
    [{ mmsi: 'A', lat: 51.95, lon: 4.14 }, { mmsi: 'C', lat: 44.41, lon: 8.9 }],
    gfs,
  );
  const e1 = diffMembership(new Map(), m1, t0, enterTimes, gfs);
  assert.equal(e1.length, 2);
  assert.ok(e1.every((e) => e.kind === 'enter'));
  const enterA = e1.find((e) => e.mmsi === 'A');
  assert.equal(enterA.gfId, 'rotterdam-port');
  assert.equal(enterA.portId, 'rotterdam');

  // Tick 2: A stays, C leaves after 90 min → one exit with dwellMin=90.
  const m2 = computeMembership([{ mmsi: 'A', lat: 51.95, lon: 4.14 }], gfs);
  const e2 = diffMembership(m1, m2, t0 + 90 * 60000, enterTimes, gfs);
  assert.equal(e2.length, 1);
  assert.equal(e2[0].kind, 'exit');
  assert.equal(e2[0].mmsi, 'C');
  assert.equal(e2[0].dwellMin, 90);
  // A's entry timestamp is retained; C's is cleared.
  assert.ok(enterTimes.has('rotterdam-port:A'));
  assert.ok(!enterTimes.has('genoa-port:C'));
});

test('a vessel already inside on the first diff (restored membership) emits no spurious enter', () => {
  const gfs = buildPortGeofences(PORTS);
  const inside = computeMembership([{ mmsi: 'X', lat: 51.95, lon: 4.14 }], gfs);
  // Simulate a relay restart where membership was restored from Redis (X already
  // inside): diffing the restored state against the same current state must NOT
  // replay X as a fresh enter (that would corrupt dwell + the event stream).
  const events = diffMembership(inside, inside, 1_700_000_000_000, new Map(), gfs);
  assert.equal(events.length, 0);
});
