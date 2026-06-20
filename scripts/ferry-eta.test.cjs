'use strict';

const { test } = require('node:test');
const { strict: assert } = require('node:assert');

const { resolveDestinationPort, etaFor } = require('./ferry-eta.cjs');

test('resolves a plain LOCODE to its port', () => {
  const p = resolveDestinationPort('ITNAP');
  assert.equal(p.portId, 'naples');
  assert.equal(p.name, 'Naples');
  assert.ok(Math.abs(p.lat - 40.84) < 0.1);
  assert.ok(Math.abs(p.lon - 14.26) < 0.1);
});

test('resolves a spaced LOCODE (IT NAP)', () => {
  assert.equal(resolveDestinationPort('IT NAP').portId, 'naples');
});

test('multi-leg / round-trip resolves to the final leg', () => {
  assert.equal(resolveDestinationPort('ITFRD-ITISH-ITNAP').portId, 'naples');
  assert.equal(resolveDestinationPort('ITPOZ<>ITPRO').portId, 'procida');
});

test('falls back to a port name when no LOCODE matches', () => {
  assert.equal(resolveDestinationPort('OLBIA').portId, 'olbia');
  assert.equal(resolveDestinationPort('>PALERMO<').portId, 'palermo');
  assert.equal(resolveDestinationPort('NAPOLI/CAPRI').portId, 'capri'); // final leg by name
});

test('returns null for out-of-scope / unknown destinations', () => {
  assert.equal(resolveDestinationPort('FRAJA'), null);  // Ajaccio, France
  assert.equal(resolveDestinationPort('ITTRS'), null);  // Trieste, not a ferry-island port
  assert.equal(resolveDestinationPort(''), null);
  assert.equal(resolveDestinationPort(undefined), null);
});

const NAPLES = { lat: 40.84, lon: 14.26 };
const CAPRI = { lat: 40.55, lon: 14.24 };
const NOW = 1_700_000_000_000;

test('etaFor returns hoursRemaining + etaTs for an under-way vessel', () => {
  const r = etaFor({ ...NAPLES, speedKnots: 20 }, CAPRI, NOW);
  assert.ok(r && r.hoursRemaining > 0 && Number.isFinite(r.hoursRemaining));
  // ~32 km at 20kn (~37 km/h) -> well under 1.5h
  assert.ok(r.hoursRemaining < 1.5);
  assert.equal(r.etaTs, Math.round(NOW + r.hoursRemaining * 3_600_000));
});

test('etaFor halves the time when speed doubles', () => {
  const slow = etaFor({ ...NAPLES, speedKnots: 10 }, CAPRI, NOW);
  const fast = etaFor({ ...NAPLES, speedKnots: 20 }, CAPRI, NOW);
  assert.ok(Math.abs(slow.hoursRemaining - 2 * fast.hoursRemaining) < 1e-6);
});

test('etaFor returns null when stopped (below underway threshold)', () => {
  assert.equal(etaFor({ ...NAPLES, speedKnots: 0.3 }, CAPRI, NOW), null);
  assert.equal(etaFor({ ...NAPLES, speedKnots: undefined }, CAPRI, NOW), null);
});
