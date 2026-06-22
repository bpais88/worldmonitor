'use strict';

const { test } = require('node:test');
const { strict: assert } = require('node:assert');

const { computePortStatus, computeAllPortStatus, congestionLevel, median, smoothPortStatus } = require('./port-status.cjs');

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

test('computeAllPortStatus accepts an ARRAY and uses each port id (not the index)', () => {
  // Mirrors italy-ferries.data.json: ports is an array of {id, ...}.
  const ports = [
    { id: 'naples', name: 'Naples', lat: 40.84, lon: 14.26, commercial: true },
    { id: 'gioia_tauro', name: 'Gioia Tauro', lat: 38.43, lon: 15.9, commercial: true },
  ];
  const resolve = (s) => (s === 'ITGIT' ? { portId: 'gioia_tauro' } : null);
  const vessels = [{ mmsi: 'in', lat: 39.0, lon: 16.5, speed: 14, destination: 'ITGIT', timestamp: NOW }];
  const out = computeAllPortStatus(ports, vessels, resolve, NOW, {}, (p) => p.commercial);
  const git = out.find((p) => p.portId === 'gioia_tauro');
  assert.ok(git, 'portId must be the real id, not an array index');
  assert.equal(git.inbound, 1); // resolves because portId === resolved id
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

test('median handles odd/even/empty', () => {
  assert.equal(median([5]), 5);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([1, 2, 3, 4]), 3); // rounded avg of middle two
  assert.equal(median([]), 0);
});

test('smoothPortStatus medians atPort over history and recomputes congestion', () => {
  const hist = new Map();
  // A noisy port: spikes to 9 then back. Median should not flip to congested on one spike.
  const feed = (atPort) => smoothPortStatus([{ portId: 'genoa', name: 'Genoa', atPort, congestion: 'x' }], hist, 5)[0];
  feed(4); feed(4);
  let p = feed(9);                 // history [4,4,9] -> median 4
  assert.equal(p.atPort, 4);
  assert.equal(p.congestion, 'busy');   // 4 -> busy, not congested from the spike
  assert.equal(p.atPortRaw, 9);
  feed(9); p = feed(9);            // history [4,4,9,9,9] -> median 9: sustained high finally registers
  assert.equal(p.atPort, 9);
  assert.equal(p.congestion, 'congested');
});
