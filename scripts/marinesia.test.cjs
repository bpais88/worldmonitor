'use strict';

const { test } = require('node:test');
const { strict: assert } = require('node:assert');

const {
  marinesiaTypeToShipType, marinesiaStatusToNavStatus, normalizeMarinesiaVessel, mergeVesselStatic, makeGrid, tileIndexFor, fetchTile, MARINESIA_TILES, MARINESIA_REGIONS, buildRegions,
} = require('./marinesia.cjs');
const { ports: REGISTRY_PORTS } = require('../src/config/maritime-ports.data.json');
const COMMERCIAL = REGISTRY_PORTS.filter((p) => p.commercial);

test('marinesiaStatusToNavStatus maps AIS status labels to numeric codes', () => {
  // The bug: Marinesia sends status as strings, so the port-status atAnchor(=1)/atBerth(=5) split
  // read 0 for all fallback vessels. These must map to the numeric domain aisstream uses.
  assert.equal(marinesiaStatusToNavStatus('At anchor'), 1);
  assert.equal(marinesiaStatusToNavStatus('Moored'), 5);
  assert.equal(marinesiaStatusToNavStatus('Under way using engine'), 0);
  assert.equal(marinesiaStatusToNavStatus('MOORED'), 5); // case-insensitive
  assert.equal(marinesiaStatusToNavStatus(1), 1); // numeric passthrough (mixed payloads)
  assert.equal(marinesiaStatusToNavStatus(15), 15);
  assert.equal(marinesiaStatusToNavStatus('nonsense'), undefined); // unknown → undefined (never a wrong code)
  assert.equal(marinesiaStatusToNavStatus(''), undefined);
  assert.equal(marinesiaStatusToNavStatus(null), undefined);
});

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

test('the tile grid is built per country from the port registry', () => {
  // Was a hardcoded 3x3 over Italian waters — which is exactly why every non-Italian port went dark
  // whenever aisstream did. One region per country with a commercial port, derived, not hand-listed.
  const countries = [...new Set(COMMERCIAL.map((p) => p.country))].sort();
  assert.deepEqual(MARINESIA_REGIONS.map((r) => r.country), countries);
  assert.equal(MARINESIA_TILES.length, MARINESIA_REGIONS.reduce((n, r) => n + r.tiles.length, 0));
  assert.ok(MARINESIA_TILES.length > 0);
});

test('EVERY commercial port falls inside a polled tile', () => {
  // The regression guard for the Lisboa bug: a port outside every tile can never be seen by the
  // fallback, so it goes dark the moment aisstream does.
  for (const p of COMMERCIAL) {
    assert.ok(tileIndexFor(MARINESIA_TILES, p.lat, p.lon) >= 0,
      `port "${p.id}" (${p.country}) sits outside every Marinesia tile — it has no fallback coverage`);
  }
});

test('a newly registered country gets tiles without touching this file', () => {
  const regions = buildRegions([
    { id: 'a', lat: 10, lon: 10, country: 'XX', commercial: true },
    { id: 'b', lat: 11, lon: 11, country: 'XX', commercial: true },
    { id: 'skip', lat: 60, lon: 60, country: 'YY', commercial: false }, // non-commercial → no region
  ]);
  assert.deepEqual(regions.map((r) => r.country), ['XX']);
  assert.ok(tileIndexFor(regions[0].tiles, 10.5, 10.5) >= 0);
});

test('each tile stays within the span the 2000-vessel cap was validated at', () => {
  for (const t of MARINESIA_TILES) {
    assert.ok(t.lat_max - t.lat_min <= 4.0 + 1e-9, 'tile lat span too wide for the per-request cap');
    assert.ok(t.long_max - t.long_min <= 4.5 + 1e-9, 'tile lon span too wide for the per-request cap');
  }
});

test('fetchTile returns the data array on success (injected fetch)', async () => {
  const fakeFetch = async () => ({
    ok: true, status: 200,
    text: async () => JSON.stringify({ error: false, data: [{ mmsi: 1 }, { mmsi: 2 }] }),
  });
  const out = await fetchTile(MARINESIA_TILES[0], 'k', fakeFetch);
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

test('mergeVesselStatic: the newest voyage snapshot wins; older never overrides', () => {
  // Newer non-empty overrides.
  assert.equal(mergeVesselStatic({ mmsi: '1', destination: 'ITNAP', timestamp: 100 },
    { mmsi: '1', destination: 'ITGOA', timestamp: 200 }).destination, 'ITGOA');
  // Older non-empty does NOT override a newer voyage value.
  assert.equal(mergeVesselStatic({ mmsi: '1', destination: 'ITNAP', timestamp: 200 },
    { mmsi: '1', destination: 'ITGOA', timestamp: 100 }).destination, 'ITNAP');
});

test('mergeVesselStatic: voyageTs (not general timestamp) governs clears', () => {
  // General timestamp (200, e.g. an aisstream receipt) is newer than the voyage
  // value's own time (voyageTs 150).
  const prev = { mmsi: '1', destination: 'ITGOA', voyageTs: 150, timestamp: 200 };
  // A clear that is newer than the voyage value (170) but older than 200.
  const v = { mmsi: '1', destination: '', timestamp: 170 };
  const m = mergeVesselStatic(prev, v);
  assert.equal(m.destination, '');   // cleared — gated on voyageTs(150), not timestamp(200)
  assert.equal(m.voyageTs, 170);
  assert.equal(m.timestamp, 200);    // freshness stays monotonic
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
  await assert.rejects(() => fetchTile(MARINESIA_TILES[0], 'k', fakeFetch), /Too Many Requests/);
});

test('tileIndexFor finds a tile that really contains the point', () => {
  // NOT "its own index": country regions overlap where countries adjoin (Portugal's box sits partly
  // inside Spain's), and tileIndexFor is first-match. Overlap costs a duplicate upsert, never a gap
  // — every tile is swept regardless — so the invariant that matters is containment, not identity.
  const contains = (t, lat, lon) => lat >= t.lat_min && lat <= t.lat_max && lon >= t.long_min && lon <= t.long_max;
  for (const t of MARINESIA_TILES) {
    const lat = (t.lat_min + t.lat_max) / 2, lon = (t.long_min + t.long_max) / 2;
    const idx = tileIndexFor(MARINESIA_TILES, lat, lon);
    assert.ok(idx >= 0 && contains(MARINESIA_TILES[idx], lat, lon), 'resolved tile must contain the point');
  }
  // And a port's coverage key must be a tile that actually covers it, or per-tile freshness would
  // be reading the recency of a tile somewhere else entirely.
  for (const p of COMMERCIAL) {
    const idx = tileIndexFor(MARINESIA_TILES, p.lat, p.lon);
    assert.ok(idx >= 0 && contains(MARINESIA_TILES[idx], p.lat, p.lon), `${p.id}: coverage tile must contain the port`);
  }
  // A 3x3 over a known box still indexes row-major, independent of the registry.
  const g = makeGrid({ lat_min: 36, lat_max: 46, long_min: 6, long_max: 19 }, 3, 3);
  assert.equal(tileIndexFor(g, 44.41, 8.93), 6);  // top lat band, first lon band
  assert.equal(tileIndexFor(g, 38.13, 13.36), 1); // bottom band, middle lon band
});

test('tileIndexFor resolves a shared tile edge to the first matching tile', () => {
  // A point exactly on the row-0/row-1 lat boundary and col-0/col-1 lon boundary is inside 4 tiles
  // by inclusive bounds — the lowest index (bottom-left of the four) wins, deterministically.
  const latEdge = MARINESIA_TILES[0].lat_max;
  const lonEdge = MARINESIA_TILES[0].long_max;
  assert.equal(tileIndexFor(MARINESIA_TILES, latEdge, lonEdge), 0);
});

test('tileIndexFor returns -1 outside the grid or for bad coords', () => {
  // Rotterdam (51.9, 4.1) used to assert -1 here — "not in the Italy grid" was the bug, not the
  // spec. It is now covered; somewhere genuinely outside every region still is not.
  assert.ok(tileIndexFor(MARINESIA_TILES, 51.9, 4.1) >= 0);
  assert.equal(tileIndexFor(MARINESIA_TILES, 1.29, 103.85), -1); // Singapore — outside every region
  assert.equal(tileIndexFor(MARINESIA_TILES, NaN, 10), -1);
  assert.equal(tileIndexFor(MARINESIA_TILES, 40, undefined), -1);
});
