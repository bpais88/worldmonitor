'use strict';

const { test } = require('node:test');
const { strict: assert } = require('node:assert');

const { assessPortCongestion } = require('./explainer-port-congestion.cjs');

const NAPLES = { lat: 40.84, lon: 14.26, name: 'Naples' };
const NOW = 1_700_000_000_000;

// A vessel near Naples; defaults to stopped + fresh.
function v(over = {}) {
  return { mmsi: String(Math.random()), lat: 40.84, lon: 14.27, speed: 0.1, navStatus: 5, timestamp: NOW, ...over };
}

test('flags congestion when enough stopped vessels cluster at the port', () => {
  const vessels = Array.from({ length: 6 }, () => v());
  const r = assessPortCongestion(NAPLES, vessels, NOW);
  assert.ok(r);
  assert.equal(r.source, 'port');
  assert.equal(r.kind, 'port_congestion');
  assert.match(r.summary, /Naples/);
  assert.match(r.summary, /6/); // includes the count
  assert.ok(r.confidence > 0);
});

test('returns null below the congestion threshold', () => {
  const vessels = Array.from({ length: 2 }, () => v());
  assert.equal(assessPortCongestion(NAPLES, vessels, NOW), null);
});

test('moving vessels near the port do not count as congestion', () => {
  const moving = Array.from({ length: 6 }, () => v({ speed: 12, navStatus: 0 }));
  assert.equal(assessPortCongestion(NAPLES, moving, NOW), null);
});

test('stale vessels (stopped reporting) do not count', () => {
  const stale = Array.from({ length: 6 }, () => v({ timestamp: NOW - 2 * 60 * 60 * 1000 }));
  assert.equal(assessPortCongestion(NAPLES, stale, NOW), null);
});

test('vessels far from the port do not count', () => {
  const far = Array.from({ length: 6 }, () => v({ lat: 38.1, lon: 13.4 })); // Palermo, ~300km
  assert.equal(assessPortCongestion(NAPLES, far, NOW), null);
});

test('the subject vessel itself is excluded', () => {
  const vessels = Array.from({ length: 4 }, (_, i) => v({ mmsi: `x${i}` }));
  // 4 total but one is the subject -> 3 others -> below threshold(4)
  assert.equal(assessPortCongestion(NAPLES, vessels, NOW, { excludeMmsi: 'x0' }), null);
});

test('counts anchored vessels even if speed field is missing', () => {
  const anchored = Array.from({ length: 5 }, () => v({ speed: undefined, navStatus: 1 }));
  const r = assessPortCongestion(NAPLES, anchored, NOW);
  assert.ok(r && r.kind === 'port_congestion');
});
