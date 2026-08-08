'use strict';

// Characterization tests for the clean-room relay entry.
//
// The assertions below are the OBSERVED contract of the predecessor relay,
// captured from a live local run on 2026-08-08 (auth matrix, headers, response
// shapes, db-less fallbacks). The new entry must match it — except where a row
// says DIVERGENCE, which marks tenant endpoints deliberately not carried over.

process.env.RELAY_SHARED_SECRET = 'test-secret';
process.env.AISSTREAM_API_KEY = '';   // no ingest in tests
process.env.MARINESIA_API_KEY = '';

const { test, before, after } = require('node:test');
const { strict: assert } = require('node:assert');
const { createRelay } = require('./relay.cjs');

let relay; let base;
const KEY = { 'x-relay-key': 'test-secret' };

before(async () => {
  relay = createRelay({ startIngest: false, startJobs: false });
  await new Promise((resolve) => relay.server.listen(0, resolve));
  base = `http://127.0.0.1:${relay.server.address().port}`;
});
after(() => relay.stop());

// ---- auth matrix (captured: /health public, everything else 401 w/o key) ----

test('auth: /health is public, data endpoints 401 without the shared secret', async () => {
  assert.equal((await fetch(`${base}/health`)).status, 200);
  for (const p of ['/metrics', '/ais/ports', '/ais/vessels?limit=2', '/ais/disruptions']) {
    assert.equal((await fetch(`${base}${p}`)).status, 401, `${p} must 401 without key`);
    assert.equal((await fetch(`${base}${p}`, { headers: KEY })).status, 200, `${p} must 200 with key`);
  }
});

test('OPTIONS preflight is 204 with CORS; POST is 405', async () => {
  const opt = await fetch(`${base}/ais/ports`, { method: 'OPTIONS' });
  assert.equal(opt.status, 204);
  assert.equal(opt.headers.get('access-control-allow-origin'), '*');
  assert.ok(opt.headers.get('access-control-allow-headers').includes('x-relay-key'));
  assert.equal((await fetch(`${base}/ais/ports`, { method: 'POST', headers: KEY })).status, 405);
});

test('unknown route is JSON 404', async () => {
  const r = await fetch(`${base}/no-such-thing`, { headers: KEY });
  assert.equal(r.status, 404);
  assert.deepEqual(await r.json(), { error: 'not found' });
});

test('DIVERGENCE: fork tenant endpoints are gone (404), by design', async () => {
  for (const p of ['/oref/alerts', '/opensky', '/rss/feed', '/worldbank', '/polymarket', '/ucdp-events', '/notam', '/yahoo-chart', '/youtube-live', '/telegram']) {
    assert.equal((await fetch(`${base}${p}`, { headers: KEY })).status, 404, `${p} must not exist`);
  }
});

// ---- headers (captured values) ----

test('/ais/ports caching + CORS headers match the captured contract', async () => {
  const r = await fetch(`${base}/ais/ports`, { headers: KEY });
  assert.equal(r.headers.get('content-type'), 'application/json');
  assert.equal(r.headers.get('cache-control'), 'public, max-age=15');
  assert.equal(r.headers.get('cdn-cache-control'), 'public, max-age=30');
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
});

test('gzip is applied when the client advertises it', async () => {
  // node fetch decompresses transparently; assert via the raw socket instead.
  const http = require('node:http');
  const enc = await new Promise((resolve, reject) => {
    http.get(`${base}/ais/ports`, { headers: { ...KEY, 'Accept-Encoding': 'gzip' } }, (res) => {
      resolve(res.headers['content-encoding']); res.resume();
    }).on('error', reject);
  });
  assert.equal(enc, 'gzip');
});

// ---- body shapes (captured, ingest-less) ----

test('/ais/ports: full per-port row shape, honest coverage, uncoveredPorts roll-up', async () => {
  const j = await (await fetch(`${base}/ais/ports`, { headers: KEY })).json();
  assert.ok(Array.isArray(j.ports) && j.ports.length > 30, 'all commercial ports present');
  assert.equal(j.count, j.ports.length);
  assert.equal(typeof j.freightTracked, 'number');
  const p = j.ports[0];
  for (const k of ['portId', 'name', 'lat', 'lon', 'region', 'atPort', 'atAnchor', 'atBerth', 'inbound', 'inboundEta', 'congestion', 'busyAt', 'congestedAt', 'atPortRaw', 'congestionRel', 'source', 'coverageOk']) {
    assert.ok(k in p, `port row missing "${k}"`);
  }
  assert.deepEqual(Object.keys(p.inboundEta), ['h6', 'h12', 'h24', 'h48']);
  // No feed is live in tests -> every port is an honest blind spot, never "clear and quiet".
  assert.ok(j.ports.every((x) => x.coverageOk === false));
  assert.deepEqual([...j.uncoveredPorts].sort(), j.ports.map((x) => x.portId).sort());
});

test('/ais/vessels: empty-store shape matches capture; filters work on injected traffic', async () => {
  let j = await (await fetch(`${base}/ais/vessels?limit=2`, { headers: KEY })).json();
  assert.deepEqual({ ...j, generatedAt: 0 }, { vessels: [], count: 0, tracked: 0, bbox: null, generatedAt: 0 });

  // Inject: one cargo ship bound for Genoa, one tug (non-freight).
  relay.state.store.applyFull({ mmsi: '111', name: 'EVER TEST', shipType: 70, lat: 43.0, lon: 8.0, speed: 14, destination: 'ITGOA', timestamp: Date.now() });
  relay.state.store.applyFull({ mmsi: '222', name: 'HARBOUR TUG', shipType: 52, lat: 43.1, lon: 8.1, speed: 5, destination: '', timestamp: Date.now() });

  j = await (await fetch(`${base}/ais/vessels?freight=1&limit=10`, { headers: KEY })).json();
  assert.equal(j.count, 1, 'freight=1 excludes the tug');
  assert.equal(j.vessels[0].mmsi, '111');
  assert.equal(j.tracked, 2);
  assert.ok(j.bbox && Number.isFinite(j.bbox.swLat));
});

test('/ais/geofences: one circle per commercial port, per-port radius honored', async () => {
  const j = await (await fetch(`${base}/ais/geofences`, { headers: KEY })).json();
  assert.ok(j.count > 30);
  const rot = j.geofences.find((g) => g.portId === 'rotterdam');
  assert.equal(rot.geometry.radiusKm, 20, 'per-port radiusKm must reach the geofence layer');
  assert.equal(rot.geometry.type, 'circle');
  assert.deepEqual(rot.rules.events, ['enter', 'exit', 'dwell']);
});

test('db-less endpoints return the captured fallback shapes', async () => {
  for (const p of ['/ais/trip?id=1', '/ais/vessel-profile?mmsi=1', '/ais/port-profile?port=genoa']) {
    const j = await (await fetch(`${base}${p}`, { headers: KEY })).json();
    assert.equal(j.found, false);
    assert.equal(j.db, false);
  }
  const s = await (await fetch(`${base}/ais/port-series?port=genoa`, { headers: KEY })).json();
  assert.deepEqual({ ...s, generatedAt: 0 }, { ts: [], ports: {}, fields: [], hours: 0, tickCount: 0, portCount: 0, generatedAt: 0, db: false });
});

test('/ais/voyages/daily: zero-filled days without a counter store', async () => {
  const j = await (await fetch(`${base}/ais/voyages/daily?days=3`, { headers: KEY })).json();
  assert.equal(j.days, 3);
  assert.equal(j.daily.length, 3);
  assert.equal(j.totalTrips, 0);
  assert.match(j.daily[0].date, /^\d{4}-\d{2}-\d{2}$/);
});

test('/ais/disruptions: empty cache shape + country filter', async () => {
  const j = await (await fetch(`${base}/ais/disruptions`, { headers: KEY })).json();
  assert.deepEqual({ ...j, generatedAt: 0 }, { events: [], count: 0, refreshedAt: null, generatedAt: 0 });
  const f = await (await fetch(`${base}/ais/disruptions?country=PT`, { headers: KEY })).json();
  assert.equal(f.count, 0);
});

test('/health reports ingest, marinesia tile ages, and db state', async () => {
  const j = await (await fetch(`${base}/health`)).json();
  assert.equal(j.status, 'ok');
  assert.equal(j.connected, false);
  assert.equal(j.db, false);
  assert.equal(j.marinesia.enabled, false);
  assert.equal(j.marinesia.tileAgesSec.length, j.marinesia.tiles);
});

// ---- tick integration: the store->delay->endpoint spine works end to end ----

test('delayTick + /ais/ports: a stopped freight vessel at Genoa is counted at the port', async () => {
  const now = Date.now();
  relay.state.store.applyFull({ mmsi: '333', name: 'MOORED ONE', shipType: 70, lat: 44.415, lon: 8.905, speed: 0, navStatus: 5, destination: 'ITGOA', timestamp: now });
  // atPort is median-smoothed over recent calls (the predecessor does the same), so a vessel
  // appearing NOW shows in atPortRaw immediately and in atPort once it persists across calls.
  let genoa = (await (await fetch(`${base}/ais/ports`, { headers: KEY })).json()).ports.find((p) => p.portId === 'genoa');
  assert.ok(genoa.atPortRaw >= 1, 'stopped vessel inside the radius counts (raw)');
  assert.ok(genoa.atBerth >= 1, 'navStatus moored counts as berthed');
  for (let i = 0; i < 4; i++) await fetch(`${base}/ais/ports`, { headers: KEY });
  genoa = (await (await fetch(`${base}/ais/ports`, { headers: KEY })).json()).ports.find((p) => p.portId === 'genoa');
  assert.ok(genoa.atPort >= 1, 'a persistent vessel survives the smoothing median');
});
