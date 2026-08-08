'use strict';

// Integration test for the relay's Method-B composition: the exact pipeline
// updateFerryDelays() runs — resolveDestinationPort -> etaFor -> recordSnapshot
// -> detectDrift — exercised over synthetic time without starting the relay.

const { test } = require('node:test');
const { strict: assert } = require('node:assert');

const { resolveDestinationPort, etaFor } = require('./ferry-eta.cjs');
const { recordSnapshot, detectDrift } = require('./eta-history.cjs');

const MIN = 60_000;

// Simulate the relay loop for one vessel across a series of (now, position, speed).
function runLoop(destString, frames) {
  let buf = [];
  let lastDrift = null;
  for (const f of frames) {
    const port = resolveDestinationPort(destString);
    if (!port) continue;
    const eta = etaFor({ lat: f.lat, lon: f.lon, speedKnots: f.speed }, port, f.now);
    buf = recordSnapshot(buf, {
      ts: f.now,
      etaTs: eta ? eta.etaTs : null,
      destPortId: port.portId,
      speed: f.speed,
    });
    lastDrift = detectDrift(buf);
  }
  return lastDrift;
}

const T0 = 1_700_000_000_000;
// A vessel that isn't getting closer (same position, still "under way") — its
// predicted arrival keeps sliding later as wall-clock advances => slipping.
const STUCK = [0, 5, 10, 15].map((m) => ({ now: T0 + m * MIN, lat: 40.70, lon: 14.25, speed: 6 }));
// A vessel making normal progress toward Capri (40.55,14.24) => steady ETA.
const PROGRESSING = [
  { now: T0 + 0 * MIN, lat: 40.74, lon: 14.25, speed: 18 },
  { now: T0 + 5 * MIN, lat: 40.70, lon: 14.25, speed: 18 },
  { now: T0 + 10 * MIN, lat: 40.66, lon: 14.25, speed: 18 },
  { now: T0 + 15 * MIN, lat: 40.62, lon: 14.25, speed: 18 },
];

test('relay pipeline flags a stuck vessel as slipping', () => {
  const d = runLoop('ITPRJ', STUCK); // ITPRJ = Capri
  assert.ok(d, 'should produce a drift result');
  assert.ok(d.slipping, 'a non-progressing under-way vessel should be slipping');
  assert.ok(d.etaGrowthMin >= 10);
});

test('relay pipeline does NOT flag a normally-progressing vessel', () => {
  const d = runLoop('ITPRJ', PROGRESSING);
  // Either no drift signal, or an explicit not-slipping/not-stalled result.
  assert.ok(!d || (!d.slipping && !d.stalled));
});

test('relay pipeline ignores vessels with an unresolvable destination', () => {
  const d = runLoop('FRAJA', STUCK); // Ajaccio, out of scope -> never snapshots
  assert.equal(d, null);
});
