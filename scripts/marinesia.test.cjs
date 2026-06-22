'use strict';

const { test } = require('node:test');
const { strict: assert } = require('node:assert');

const {
  marinesiaTypeToShipType, normalizeMarinesiaVessel, makeGrid, fetchTile, ITALY_TILES,
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

test('fetchTile throws on an API error envelope', async () => {
  const fakeFetch = async () => ({
    ok: true, status: 200,
    text: async () => JSON.stringify({ error: true, message: 'Too Many Requests' }),
  });
  await assert.rejects(() => fetchTile(ITALY_TILES[0], 'k', fakeFetch), /Too Many Requests/);
});
