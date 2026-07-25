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

test('splits atPort into atAnchor (waiting) and atBerth (moored) by navStatus', () => {
  const s = computePortStatus(PORT, [
    near({ mmsi: 'a', navStatus: 1 }),            // at anchor → queue
    near({ mmsi: 'b', navStatus: 5, speed: 2 }),  // moored → berthed
    near({ mmsi: 'c', speed: 0 }),                // stopped, no navStatus → atPort only
  ], resolveDest, NOW);
  assert.equal(s.atPort, 3);
  assert.equal(s.atAnchor, 1);
  assert.equal(s.atBerth, 1);
});

test('buckets inbound vessels by geometric ETA (cumulative h6/h12/h24/h48)', () => {
  // Same longitude as the port; Δlat×~111km ÷ (15 kn×1.852) gives the ETA.
  const vNear = { mmsi: 'n', lat: PORT.lat + 0.9, lon: PORT.lon, speed: 15, destination: 'ITGIT', timestamp: NOW }; // ~100km → ~3.6h
  const vFar = { mmsi: 'f', lat: PORT.lat + 3.6, lon: PORT.lon, speed: 15, destination: 'ITGIT', timestamp: NOW }; // ~400km → ~14.4h
  const s = computePortStatus(PORT, [vNear, vFar], resolveDest, NOW);
  assert.equal(s.inbound, 2);
  assert.equal(s.inboundEta.h6, 1); // vNear only
  assert.equal(s.inboundEta.h12, 1); // vNear only
  assert.equal(s.inboundEta.h24, 2); // both
  assert.equal(s.inboundEta.h48, 2); // both
});

// Both fixtures above arrive inside 15h, so h48 was satisfied by vessels already counted in h24 —
// the 24-48h band was asserted but never actually populated. That is an Italy-shaped assumption:
// Mediterranean legs are hours, so nothing exercised a genuinely multi-day approach until Portugal
// (Atlantic, routinely 40h+) put one in front of a user. These two fill the band and its far edge.
test('a genuinely multi-day approach lands in h48 only, not the shorter buckets', () => {
  const vDays = { mmsi: 'd', lat: PORT.lat + 9.0, lon: PORT.lon, speed: 15, destination: 'ITGIT', timestamp: NOW }; // ~1000km → ~36h
  const s = computePortStatus(PORT, [vDays], resolveDest, NOW);
  assert.equal(s.inbound, 1);
  assert.deepEqual(s.inboundEta, { h6: 0, h12: 0, h24: 0, h48: 1 });
});

test('beyond 48h still counts as inbound but falls in no arrival bucket', () => {
  // The buckets are an arrival horizon, not a census — a vessel 60h out is under way and bound here,
  // but promoting it into h48 would overstate what arrives in the next two days.
  const vFar = { mmsi: 'w', lat: PORT.lat + 15.0, lon: PORT.lon, speed: 15, destination: 'ITGIT', timestamp: NOW }; // ~1670km → ~60h
  const s = computePortStatus(PORT, [vFar], resolveDest, NOW);
  assert.equal(s.inbound, 1);
  assert.deepEqual(s.inboundEta, { h6: 0, h12: 0, h24: 0, h48: 0 });
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

// --- Per-port radius + the non-overlap invariant ------------------------------------------------
const { ports: ALL_PORTS } = require('../src/config/italy-ferries.data.json');
const { haversineKm } = require('./ferry-eta.cjs');
const COMMERCIAL = ALL_PORTS.filter((p) => p.commercial);
const radiusOf = (p) => (Number.isFinite(p.radiusKm) ? p.radiusKm : 8);

test('a port row can override the at-port radius', () => {
  const v = { mmsi: 'r', lat: PORT.lat + 0.09, lon: PORT.lon, speed: 0, timestamp: NOW }; // ~10km out
  assert.equal(computePortStatus(PORT, [v], resolveDest, NOW).atPort, 0);                  // default 8km: outside
  assert.equal(computePortStatus({ ...PORT, radiusKm: 20 }, [v], resolveDest, NOW).atPort, 1);
  assert.equal(computePortStatus({ ...PORT, radiusKm: 2.5 }, [v], resolveDest, NOW).atPort, 0);
});

test('an invalid per-port radius falls back to the default rather than counting nothing', () => {
  const v = { mmsi: 'r', lat: PORT.lat + 0.02, lon: PORT.lon, speed: 0, timestamp: NOW }; // ~2km out
  for (const bad of [null, undefined, 'wide', NaN]) {
    assert.equal(computePortStatus({ ...PORT, radiusKm: bad }, [v], resolveDest, NOW).atPort, 1, String(bad));
  }
});

test('no two commercial ports have overlapping at-port discs', () => {
  // Overlap means one berthed vessel is counted at BOTH ports — inflating each, and inflating the
  // baselines they are later judged against. This invariant is what makes a per-port radius safe
  // to widen: you cannot grow one port's disc into its neighbour without failing here.
  for (let i = 0; i < COMMERCIAL.length; i++) {
    for (let j = i + 1; j < COMMERCIAL.length; j++) {
      const a = COMMERCIAL[i], b = COMMERCIAL[j];
      const gap = haversineKm(a, b);
      assert.ok(
        radiusOf(a) + radiusOf(b) <= gap,
        `${a.id} (r=${radiusOf(a)}km) and ${b.id} (r=${radiusOf(b)}km) are only ${gap.toFixed(1)}km apart — ` +
          `their at-port discs overlap, so a vessel berthed between them counts at both. ` +
          `Lower one or both "radiusKm" in the port registry.`,
      );
    }
  }
});

test('every per-port radius is a positive, plausible distance', () => {
  for (const p of COMMERCIAL) {
    if (p.radiusKm === undefined) continue;
    assert.ok(Number.isFinite(p.radiusKm) && p.radiusKm > 0 && p.radiusKm <= 40,
      `${p.id}: radiusKm ${p.radiusKm} is not a plausible port extent (expected 0 < r <= 40 km)`);
  }
});
