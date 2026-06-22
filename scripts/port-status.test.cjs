'use strict';

const { test } = require('node:test');
const { strict: assert } = require('node:assert');

const { computePortStatus, computeAllPortStatus, congestionLevel } = require('./port-status.cjs');

// Gioia Tauro terminal.
const PORT = { portId: 'gioia_tauro', name: 'Gioia Tauro', lat: 38.43, lon: 15.9, region: 'Calabria' };
// A vessel ~2km from the port (within the 8km radius).
const near = (over = {}) => ({ mmsi: 'x', lat: 38.44, lon: 15.91, speed: 0, timestamp: 1000, ...over });
// A vessel far away (~hundreds of km).
const far = (over = {}) => ({ mmsi: 'y', lat: 45.0, lon: 12.0, speed: 15, timestamp: 1000, ...over });

const resolveDest = (s) => (s === 'ITGIT' ? { portId: 'gioia_tauro' } : null);
const NOW = 1000;

test('counts stopped vessels within radius as atPort', () => {
  const s = computePortStatus(PORT, [near({ mmsi: 'a' }), near({ mmsi: 'b', speed: 0.5 })], resolveDest, NOW);
  assert.equal(s.atPort, 2);
  assert.equal(s.inbound, 0);
});

test('a moored/anchored vessel counts as at port even with speed', () => {
  const s = computePortStatus(PORT, [near({ navStatus: 5, speed: 3 })], resolveDest, NOW);
  assert.equal(s.atPort, 1);
});

test('counts under-way vessels bound for the port as inbound (not atPort)', () => {
  const s = computePortStatus(PORT, [far({ speed: 16, destination: 'ITGIT' })], resolveDest, NOW);
  assert.equal(s.inbound, 1);
  assert.equal(s.atPort, 0);
});

test('a stopped vessel at the port is atPort, not double-counted as inbound', () => {
  const s = computePortStatus(PORT, [near({ speed: 0, destination: 'ITGIT' })], resolveDest, NOW);
  assert.equal(s.atPort, 1);
  assert.equal(s.inbound, 0);
});

test('ignores stale vessels (older than freshMs)', () => {
  const s = computePortStatus(PORT, [near({ timestamp: NOW - 60 * 60_000 })], resolveDest, NOW);
  assert.equal(s.atPort, 0);
});

test('congestion level scales with the at-port count', () => {
  const many = (n) => Array.from({ length: n }, (_, i) => near({ mmsi: `m${i}` }));
  assert.equal(computePortStatus(PORT, many(2), resolveDest, NOW).congestion, 'clear');
  assert.equal(computePortStatus(PORT, many(5), resolveDest, NOW).congestion, 'busy');
  assert.equal(computePortStatus(PORT, many(9), resolveDest, NOW).congestion, 'congested');
});

test('congestionLevel thresholds', () => {
  const o = { busyAt: 4, congestedAt: 8 };
  assert.equal(congestionLevel(0, o), 'clear');
  assert.equal(congestionLevel(4, o), 'busy');
  assert.equal(congestionLevel(8, o), 'congested');
});

test('computeAllPortStatus filters, skips coord-less ports, and sorts by severity', () => {
  const ports = {
    gioia_tauro: { name: 'Gioia Tauro', lat: 38.43, lon: 15.9, commercial: true },
    quiet: { name: 'Quiet', lat: 40.0, lon: 9.0, commercial: true },
    nocoord: { name: 'NoCoord', commercial: true },
    tourist: { name: 'Tourist', lat: 40.8, lon: 14.2, commercial: false },
  };
  const vessels = [
    ...Array.from({ length: 9 }, (_, i) => ({ mmsi: `g${i}`, lat: 38.44, lon: 15.91, speed: 0, timestamp: NOW })),
  ];
  const out = computeAllPortStatus(ports, vessels, resolveDest, NOW, {}, (p) => p.commercial);
  assert.equal(out.length, 2);                 // tourist filtered, nocoord skipped
  assert.equal(out[0].portId, 'gioia_tauro');  // most congested first
  assert.equal(out[0].congestion, 'congested');
  assert.equal(out[1].portId, 'quiet');
});
