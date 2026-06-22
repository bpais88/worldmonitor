'use strict';

const { test } = require('node:test');
const { strict: assert } = require('node:assert');

const { resolveDestinationPort, etaFor, resolveOperatorName, resolveOperator, isFreightVessel, __setImoRegistryForTests } = require('./ferry-eta.cjs');

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
  assert.equal(resolveDestinationPort('HRSPU'), null);  // Split, Croatia — out of scope
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

test('resolveOperator returns { id, name } for a known operator, null otherwise', () => {
  assert.deepEqual(resolveOperator('MOBY TOMMY'), { id: 'moby', name: 'Moby Lines' });
  assert.deepEqual(resolveOperator('GNV AZZURRA'), { id: 'gnv', name: 'Grandi Navi Veloci' });
  assert.equal(resolveOperator('UNKNOWN VESSEL'), null);
  assert.equal(resolveOperator(''), null);
});

test('resolveOperatorName matches a known operator from the vessel name', () => {
  assert.equal(resolveOperatorName('CAREMAR DRIADE'), 'Caremar');
  assert.equal(resolveOperatorName('GNV AZZURRA'), 'Grandi Navi Veloci');
  assert.equal(resolveOperatorName('MOBY TOMMY'), 'Moby Lines');
  assert.equal(resolveOperatorName('UNKNOWN VESSEL'), '');
  assert.equal(resolveOperatorName(''), '');
});

test('isFreightVessel: cargo always; passenger only if a freight RoPax operator', () => {
  // Cargo / RoRo (type 70-79) — always freight, operator irrelevant.
  assert.equal(isFreightVessel(70, 'MSC GENOVA'), true);
  assert.equal(isFreightVessel(79, ''), true);
  // Passenger (60-69) operated by a freight RoPax line — freight.
  assert.equal(isFreightVessel(60, 'GNV ALLEGRA'), true);
  assert.equal(isFreightVessel(69, 'MOBY TOMMY'), true);
  // Passenger but a CRUISE ship (not a freight operator) — excluded.
  assert.equal(isFreightVessel(60, 'MSC SEAVIEW'), false);
  // Passenger tourist ferry (Caremar) — excluded.
  assert.equal(isFreightVessel(60, 'CAREMAR DRIADE'), false);
  // HSC hydrofoil + tanker — excluded.
  assert.equal(isFreightVessel(40, 'LIBERTY LINES JET'), false);
  assert.equal(isFreightVessel(80, 'SOME TANKER'), false);
});

test('isFreightVessel: IMO registry (Equasis) overrides the heuristic', () => {
  __setImoRegistryForTests({
    '9999001': { freight: true },   // a passenger vessel verified as RoPax
    '9999002': { freight: false },  // a passenger vessel verified as a CRUISE ship
  });
  try {
    // Heuristic alone would say false (passenger, no freight operator) -> registry says freight.
    assert.equal(isFreightVessel(60, 'UNKNOWN LINE', '9999001'), true);
    // Heuristic would also say false; registry confirms cruise -> stays false.
    assert.equal(isFreightVessel(60, 'GNV CRUISE ONE', '9999002'), false); // registry beats operator match
    // IMO not in registry -> falls back to heuristic (cargo => freight).
    assert.equal(isFreightVessel(70, 'WHATEVER', '0000000'), true);
    // No IMO -> heuristic.
    assert.equal(isFreightVessel(60, 'GNV ALLEGRA'), true);
  } finally {
    __setImoRegistryForTests(null); // restore real registry
  }
});
