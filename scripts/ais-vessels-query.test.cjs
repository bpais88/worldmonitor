'use strict';

// Unit tests for the relay's /ais/vessels query/filter logic.
// Run: node --test scripts/ais-vessels-query.test.cjs

const { strict: assert } = require('node:assert');
const test = require('node:test');
const {
  shipTypeCategory,
  parseBbox,
  parseTypes,
  clampLimit,
  buildVesselList,
} = require('./ais-vessels-query.cjs');
const { resolveOperator } = require('./ferry-eta.cjs');

// Realistic vessel records as stored by the relay (PositionReport-derived).
function makeMaps() {
  const vessels = new Map([
    // Moby ferry off Civitavecchia, under way (no shipType on position report)
    ['247111111', { mmsi: '247111111', name: 'MOBY DADA', lat: 42.0, lon: 11.5, speed: 19.2, course: 250, heading: 251, navStatus: 0, timestamp: 1000 }],
    // Cargo ship in the Tyrrhenian
    ['636000001', { mmsi: '636000001', name: 'EVER GIVEN', lat: 41.0, lon: 11.0, speed: 14, course: 90, navStatus: 0, shipType: 70, timestamp: 1001 }],
    // Fast hydrofoil near Naples
    ['247222222', { mmsi: '247222222', name: 'LIBERTY LINES JET', lat: 40.8, lon: 14.2, speed: 30, course: 180, navStatus: 0, shipType: 40, timestamp: 1002 }],
    // A vessel far outside Italy (Atlantic)
    ['366000001', { mmsi: '366000001', name: 'US BOX', lat: 40.0, lon: -70.0, speed: 12, navStatus: 0, shipType: 70, timestamp: 1003 }],
  ]);
  // Static data (ShipStaticData-derived): destination + IMO + ship type
  const vesselStatic = new Map([
    ['247111111', { mmsi: '247111111', name: 'MOBY DADA', shipType: 60, imo: '9200096', destination: 'OLBIA', callSign: 'IBMD', draught: 6.4, length: 175, beam: 27, etaAis: '06-21 14:30Z', timestamp: 900 }],
    ['636000001', { mmsi: '636000001', name: 'EVER GIVEN', shipType: 70, imo: '9811000', destination: 'GENOVA', timestamp: 901 }],
  ]);
  return { vessels, vesselStatic };
}

const ITALY = parseBbox('35,6,46.5,19.5');

test('shipTypeCategory buckets ranges', () => {
  assert.equal(shipTypeCategory(60), 'passenger');
  assert.equal(shipTypeCategory(70), 'cargo');
  assert.equal(shipTypeCategory(80), 'tanker');
  assert.equal(shipTypeCategory(40), 'hsc');
  assert.equal(shipTypeCategory(undefined), 'other');
});

test('parseBbox normalizes and rejects bad input', () => {
  assert.deepEqual(parseBbox('46.5,19.5,35,6'), { swLat: 35, neLat: 46.5, swLon: 6, neLon: 19.5 });
  assert.equal(parseBbox('1,2,3'), null);
  assert.equal(parseBbox('a,b,c,d'), null);
  assert.equal(parseBbox(null), null);
});

test('parseTypes / clampLimit', () => {
  assert.deepEqual([...parseTypes('passenger, hsc')], ['passenger', 'hsc']);
  assert.equal(parseTypes(''), null);
  assert.equal(clampLimit('10', { def: 2000, max: 5000 }), 10);
  assert.equal(clampLimit(undefined, { def: 2000, max: 5000 }), 2000);
  assert.equal(clampLimit('999999', { def: 2000, max: 5000 }), 5000);
  // 0 / invalid is falsy => falls back to the default (preserved relay behavior).
  assert.equal(clampLimit('0', { def: 2000, max: 5000 }), 2000);
  assert.equal(clampLimit('abc', { def: 2000, max: 5000 }), 2000);
});

test('bbox filter drops vessels outside Italy', () => {
  const { vessels, vesselStatic } = makeMaps();
  const out = buildVesselList(vessels, vesselStatic, { bounds: ITALY, wantTypes: null, limit: 100 });
  const mmsis = out.map((v) => v.mmsi);
  assert.ok(mmsis.includes('247111111'));
  assert.ok(!mmsis.includes('366000001')); // Atlantic vessel excluded
});

test('type filter keeps only passenger + hsc (ferries)', () => {
  const { vessels, vesselStatic } = makeMaps();
  const out = buildVesselList(vessels, vesselStatic, {
    bounds: ITALY,
    wantTypes: parseTypes('passenger,hsc'),
    limit: 100,
  });
  const names = out.map((v) => v.name).sort();
  assert.deepEqual(names, ['LIBERTY LINES JET', 'MOBY DADA']);
});

test('static data merges destination + IMO, and supplies ship type', () => {
  const { vessels, vesselStatic } = makeMaps();
  const out = buildVesselList(vessels, vesselStatic, { bounds: ITALY, wantTypes: null, limit: 100 });
  const moby = out.find((v) => v.mmsi === '247111111');
  // Position report had no shipType; static data supplies 60 => passenger.
  assert.equal(moby.shipType, 60);
  assert.equal(moby.category, 'passenger');
  assert.equal(moby.destination, 'OLBIA');
  assert.equal(moby.imo, '9200096');
  assert.equal(moby.navStatus, 0);
  // New voyage/identity fields flow through from static data.
  assert.equal(moby.callSign, 'IBMD');
  assert.equal(moby.draught, 6.4);
  assert.equal(moby.length, 175);
  assert.equal(moby.beam, 27);
  assert.equal(moby.etaAis, '06-21 14:30Z');
});

test('vessel with static data but no extra fields yields empty/undefined', () => {
  const { vessels, vesselStatic } = makeMaps();
  const out = buildVesselList(vessels, vesselStatic, { bounds: ITALY, wantTypes: null, limit: 100 });
  const ever = out.find((v) => v.mmsi === '636000001');
  assert.equal(ever.callSign, '');
  assert.equal(ever.draught, undefined);
  assert.equal(ever.etaAis, '');
});

test('limit caps the result count', () => {
  const { vessels, vesselStatic } = makeMaps();
  const out = buildVesselList(vessels, vesselStatic, { bounds: null, wantTypes: null, limit: 2 });
  assert.equal(out.length, 2);
});

test('vessel without static data still returns with empty destination/imo', () => {
  const { vessels, vesselStatic } = makeMaps();
  const out = buildVesselList(vessels, vesselStatic, { bounds: ITALY, wantTypes: parseTypes('hsc'), limit: 100 });
  const jet = out.find((v) => v.mmsi === '247222222');
  assert.equal(jet.destination, '');
  assert.equal(jet.imo, '');
  assert.equal(jet.category, 'hsc');
});

test('resolveOperator attaches authoritative operatorId/operatorName', () => {
  const { vessels, vesselStatic } = makeMaps();
  const out = buildVesselList(vessels, vesselStatic, { bounds: ITALY, wantTypes: null, limit: 100, resolveOperator });
  const moby = out.find((v) => v.mmsi === '247111111');
  assert.equal(moby.operatorId, 'moby');
  assert.equal(moby.operatorName, 'Moby Lines');
  // Non-operator cargo gets empty operator fields, not undefined.
  const ever = out.find((v) => v.mmsi === '636000001');
  assert.equal(ever.operatorId, '');
  assert.equal(ever.operatorName, '');
});

test('wantOperator restricts the result to one operator (server-side filter)', () => {
  const { vessels, vesselStatic } = makeMaps();
  const out = buildVesselList(vessels, vesselStatic, { bounds: ITALY, wantTypes: null, limit: 100, resolveOperator, wantOperator: 'moby' });
  assert.equal(out.length, 1);
  assert.equal(out[0].mmsi, '247111111');
});
