'use strict';

const { test } = require('node:test');
const { strict: assert } = require('node:assert');

const {
  upsertVessel, registryFreight, pruneRegistry,
  serializeRegistry, deserializeRegistry,
} = require('./vessel-registry.cjs');

const NOW = 1_700_000_000_000;

test('upsertVessel records a new vessel keyed by IMO', () => {
  const reg = new Map();
  upsertVessel(reg, { imo: '9111111', name: 'GNV ALLEGRA', shipType: 60, operatorName: 'Grandi Navi Veloci', freight: true }, NOW);
  const e = reg.get('9111111');
  assert.equal(e.name, 'GNV ALLEGRA');
  assert.equal(e.shipType, 60);
  assert.equal(e.freight, true);
  assert.equal(e.firstSeenTs, NOW);
  assert.equal(e.lastSeenTs, NOW);
});

test('upsertVessel ignores observations without an IMO (no key)', () => {
  const reg = new Map();
  upsertVessel(reg, { imo: '', name: 'X', shipType: 70, freight: true }, NOW);
  assert.equal(reg.size, 0);
});

test('re-observation fills missing fields and bumps lastSeen, keeps firstSeen', () => {
  const reg = new Map();
  upsertVessel(reg, { imo: '9111111', name: 'MSC X', freight: true }, NOW);       // no shipType yet
  upsertVessel(reg, { imo: '9111111', shipType: 70, freight: true }, NOW + 60_000); // shipType arrives, no name
  const e = reg.get('9111111');
  assert.equal(e.name, 'MSC X');     // retained
  assert.equal(e.shipType, 70);      // filled
  assert.equal(e.firstSeenTs, NOW);
  assert.equal(e.lastSeenTs, NOW + 60_000);
});

test('a verified (Equasis) freight verdict is sticky — observed cannot overwrite it', () => {
  const reg = new Map();
  upsertVessel(reg, { imo: '9111111', name: 'CRUISE ROMA', freight: true, verified: true }, NOW); // Equasis: RoPax freight
  upsertVessel(reg, { imo: '9111111', name: 'CRUISE ROMA', shipType: 60, freight: false }, NOW + 60_000); // heuristic guesses tourist
  assert.equal(reg.get('9111111').freight, true);  // verified wins
  assert.equal(reg.get('9111111').verified, true);
});

test('registryFreight returns the remembered verdict or null', () => {
  const reg = new Map();
  upsertVessel(reg, { imo: '9111111', shipType: 70, freight: true }, NOW);
  assert.equal(registryFreight(reg, '9111111'), true);
  assert.equal(registryFreight(reg, '0000000'), null);
  assert.equal(registryFreight(reg, undefined), null);
});

test('pruneRegistry drops vessels not seen within the TTL', () => {
  const reg = new Map();
  upsertVessel(reg, { imo: 'old', shipType: 70, freight: true }, NOW - 40 * 24 * 3600_000);
  upsertVessel(reg, { imo: 'new', shipType: 70, freight: true }, NOW);
  pruneRegistry(reg, NOW, 30 * 24 * 3600_000);
  assert.equal(reg.has('old'), false);
  assert.equal(reg.has('new'), true);
});

test('serialize/deserialize round-trips the registry', () => {
  const reg = new Map();
  upsertVessel(reg, { imo: '9111111', name: 'GNV', shipType: 60, freight: true, verified: true }, NOW);
  const restored = deserializeRegistry(serializeRegistry(reg));
  assert.deepEqual(restored.get('9111111'), reg.get('9111111'));
});
