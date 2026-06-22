'use strict';

const { test } = require('node:test');
const { strict: assert } = require('node:assert');

const {
  marinesiaTypeToShipType, normalizeMarinesiaVessel, mergeVesselStatic, makeGrid, fetchTile, ITALY_TILES,
} = require('./marinesia.cjs');

test('marinesiaTypeToShipType maps strings to the right AIS band', () => {
  assert.equal(marinesiaTypeToShipType('Cargo'), 70);
  assert.equal(marinesiaTypeToShipType('Tanker'), 80);
  assert.equal(marinesiaTypeToShipType('Passenger'), 60);
  assert.equal(marinesiaTypeToShipType('High Speed Craft'), 40);
  assert.equal(marinesiaTypeToShipType('Pleasure Craft'), 37);
  assert.equal(marinesiaTypeToShipType('cargo'), 70); // case-insensitive
});

test('marinesiaTypeToShipType returns undefined for unknown/uncategorized', () => {
  assert.equal(marinesiaTypeToShipType('Uncategorized'), undefined);
  assert.equal(marinesiaTypeToShipType('Other Type'), undefined);
  assert.equal(marinesiaTypeToShipType(''), undefined);
  assert.equal(marinesiaTypeToShipType(null), undefined);
});

test('normalizeMarinesiaVessel maps a real cargo object to internal shape', () => {
  // Shape observed live from the area endpoint.
  const raw = {
    name: 'RANGAKU', imo: 9866627, type: 'Cargo', flag: 'PAN',
    a: 100, b: 50, c: 12, d: 13, mmsi: 351234000,
    lat: 45.43, lng: 12.33, cog: 270.5, sog: 11.2, rot: 0, hdt: 268,
    dest: 'ITVCE', eta: '06-22 18:00', draught: 7.4, ts: '2026-06-22T09:00:14', status: 0,
  };
  const v = normalizeMarinesiaVessel(raw);
  assert.equal(v.mmsi, '351234000');     // stringified
  assert.equal(v.imo, '9866627');        // stringified
  assert.equal(v.name, 'RANGAKU');
  assert.equal(v.shipType, 70);          // Cargo -> 70
  assert.equal(v.lon, 12.33);            // lng -> lon
  assert.equal(v.lat, 45.43);
  assert.equal(v.speed, 11.2);           // sog
  assert.equal(v.course, 270.5);         // cog
  assert.equal(v.heading, 268);          // hdt
  assert.equal(v.navStatus, 0);          // status
  assert.equal(v.destination, 'ITVCE');
  assert.equal(v.length, 150);           // a+b
  assert.equal(v.beam, 25);              // c+d
  assert.equal(v.draught, 7.4);
  assert.equal(v.timestamp, Date.parse('2026-06-22T09:00:14Z')); // ts as UTC
});

test('normalizeMarinesiaVessel handles missing imo / dimensions', () => {
  const v = normalizeMarinesiaVessel({
    name: 'AMOROSO', imo: null, type: 'Pleasure Craft',
    a: null, b: null, c: null, d: null, mmsi: 238100740,
    lat: 43.39, lng: 16.19, cog: 337, sog: 5.6, dest: null, eta: null, ts: '2026-06-22T08:59:42', status: 15,
  });
  assert.equal(v.imo, '');
  assert.equal(v.length, undefined);
  assert.equal(v.beam, undefined);
  assert.equal(v.destination, '');
  assert.equal(v.shipType, 37);
});

test('normalizeMarinesiaVessel returns null without an mmsi', () => {
  assert.equal(normalizeMarinesiaVessel({ name: 'X', lat: 1, lng: 2 }), null);
  assert.equal(normalizeMarinesiaVessel(null), null);
});

test('makeGrid splits a bbox into rows×cols contiguous tiles', () => {
  const tiles = makeGrid({ lat_min: 0, lat_max: 10, long_min: 0, long_max: 10 }, 2, 2);
  assert.equal(tiles.length, 4);
  // First tile is the SW corner.
  assert.deepEqual(tiles[0], { lat_min: 0, lat_max: 5, long_min: 0, long_max: 5 });
  // Tiles cover the full box: max corner present.
  assert.ok(tiles.some(t => t.lat_max === 10 && t.long_max === 10));
  // No gaps: every tile is 5×5.
  for (const t of tiles) {
    assert.equal(t.lat_max - t.lat_min, 5);
    assert.equal(t.long_max - t.long_min, 5);
  }
});

test('ITALY_TILES is a 3×3 grid (9 tiles)', () => {
  assert.equal(ITALY_TILES.length, 9);
});

test('fetchTile returns the data array on success (injected fetch)', async () => {
  const fakeFetch = async () => ({
    ok: true, status: 200,
    text: async () => JSON.stringify({ error: false, data: [{ mmsi: 1 }, { mmsi: 2 }] }),
  });
  const out = await fetchTile(ITALY_TILES[0], 'k', fakeFetch);
  assert.equal(out.length, 2);
});

test('mergeVesselStatic preserves static identity when a row omits it', () => {
  const prev = { mmsi: '1', name: 'EUROCARGO RAVENNA', shipType: 70, imo: '9471056', destination: 'ITCAG', callSign: 'IBXY', draught: 7.5, length: 200, beam: 26, etaAis: '06-22 10:30', timestamp: 100 };
  // A later poll where the STATIC fields dropped out (imo blank, type unknown).
  const v = { mmsi: '1', name: 'EUROCARGO RAVENNA', shipType: undefined, imo: '', destination: 'ITCAG', draught: 7.5, length: 200, beam: 26, etaAis: '06-22 10:30', timestamp: 200 };
  const m = mergeVesselStatic(prev, v, 999);
  assert.equal(m.imo, '9471056');         // preserved
  assert.equal(m.shipType, 70);           // preserved
  assert.equal(m.callSign, 'IBXY');       // Marinesia has none -> kept
  assert.equal(m.length, 200);            // preserved
  assert.equal(m.timestamp, 200);         // new wins
});

test('mergeVesselStatic lets a CLEARED destination/eta reset when the row is newer', () => {
  const prev = { mmsi: '1', name: 'X', shipType: 70, imo: '9471056', destination: 'ITCAG', etaAis: '06-22 10:30', callSign: 'IBXY', timestamp: 100 };
  // Vessel arrived and cleared its AIS destination — newer Marinesia row reports empty.
  const v = { mmsi: '1', name: 'X', shipType: 70, imo: '', destination: '', etaAis: '', timestamp: 200 };
  const m = mergeVesselStatic(prev, v);
  assert.equal(m.destination, '');        // cleared (incoming is newer)
  assert.equal(m.etaAis, '');             // cleared
  assert.equal(m.imo, '9471056');         // static identity still preserved
  assert.equal(m.callSign, 'IBXY');       // static still preserved
  assert.equal(m.timestamp, 200);
});

test('mergeVesselStatic does NOT let an OLDER empty voyage field clear a newer one', () => {
  // e.g. aisstream wrote a fresh destination; a lagging Marinesia row arrives empty.
  const prev = { mmsi: '1', destination: 'ITNAP', etaAis: '06-22 12:00', imo: '9', timestamp: 200 };
  const v = { mmsi: '1', destination: '', etaAis: '', imo: '', timestamp: 100 };
  const m = mergeVesselStatic(prev, v);
  assert.equal(m.destination, 'ITNAP');     // preserved — incoming row is older
  assert.equal(m.etaAis, '06-22 12:00');    // preserved
  assert.equal(m.timestamp, 200);           // monotonic — not regressed to 100
});

test('mergeVesselStatic: a newer NON-empty destination always overrides regardless', () => {
  const prev = { mmsi: '1', destination: 'ITNAP', timestamp: 200 };
  const v = { mmsi: '1', destination: 'ITGOA', timestamp: 100 }; // older but has a real value
  assert.equal(mergeVesselStatic(prev, v).destination, 'ITGOA');
});

test('mergeVesselStatic lets newer defined values override', () => {
  const prev = { mmsi: '1', destination: 'ITCAG', imo: '9471056', shipType: 70 };
  const v = { mmsi: '1', destination: 'ITGOA', imo: '9471056', shipType: 70, timestamp: 5 };
  const m = mergeVesselStatic(prev, v);
  assert.equal(m.destination, 'ITGOA');   // updated
});

test('mergeVesselStatic works with no prior record', () => {
  const v = { mmsi: '1', name: 'X', shipType: 70, imo: '', destination: 'ITNAP', timestamp: 5 };
  const m = mergeVesselStatic(undefined, v);
  assert.equal(m.destination, 'ITNAP');
  assert.equal(m.imo, '');
  assert.equal(m.callSign, '');
});

test('fetchTile throws on an API error envelope', async () => {
  const fakeFetch = async () => ({
    ok: true, status: 200,
    text: async () => JSON.stringify({ error: true, message: 'Too Many Requests' }),
  });
  await assert.rejects(() => fetchTile(ITALY_TILES[0], 'k', fakeFetch), /Too Many Requests/);
});
