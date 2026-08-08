'use strict';

// Marinesia AIS provider (REST, polled) — an alternative/fallback upstream to
// aisstream. The free aisstream stream is unreliable (months-long zero-frame
// outages); Marinesia Premium returns up to 2000 vessels per bounding-box
// request, pre-joined (position + identity + destination LOCODE in one object).
//
// The endpoint caps a single box at 2000 vessels and offers no type filter or
// pagination, so we TILE the region into sub-boxes — each expected to return
// under the cap — and poll them round-robin within the rate limit (5 req/min on
// Premium). Pure helpers here (normalize/typemap/grid) unit-test without I/O;
// fetchTile is the only network call and takes an injectable fetch.
//
// Endpoint: GET https://api.marinesia.com/api/v2/vessel/area
//   ?key=&lat_min=&lat_max=&long_min=&long_max=
// Response: { error, message, data: [ { name, imo, type, flag, a,b,c,d, mmsi,
//   lat, lng, cog, sog, rot, hdt, dest, eta, draught, ts, status }, ... ] }

const AREA_URL = 'https://api.marinesia.com/api/v2/vessel/area';
const VESSEL_CAP = 2000; // Premium per-request cap; a tile returning this many is truncated.

// Marinesia reports `type` as a human string; our classification expects a
// numeric AIS ship type. Map to a representative code in the right AIS band so
// isFreightVessel/classifyFreight work unchanged (cargo 70-79, tanker 80-89,
// passenger 60-69, HSC 40-49, etc.). Unknown -> undefined.
function marinesiaTypeToShipType(type) {
  switch (String(type || '').trim().toLowerCase()) {
    case 'cargo': return 70;
    case 'tanker': return 80;
    case 'passenger': return 60;
    case 'high speed craft': return 40;
    case 'fishing': return 30;
    case 'sailing': return 36;
    case 'pleasure craft': return 37;
    case 'tug': return 52;
    case 'towing': return 31;
    case 'dredging': return 33;
    case 'diving': return 34;
    case 'pilot': return 50;
    case 'search and rescue': return 51;
    case 'port tender': return 53;
    case 'anti-pollution': return 54;
    case 'law enforcement': return 55;
    case 'noncombatant': return 59;
    default: return undefined; // Uncategorized / Unknown / Reserved / Other Type / null
  }
}

// Marinesia reports `status` as a human AIS navigational-status STRING ('At anchor', 'Moored',
// 'Under way using engine', …); the rest of the system stores navStatus as the numeric ITU-R
// M.1371 code (aisstream passes pos.NavigationalStatus). Map to that numeric domain so
// port-status's atAnchor(=1)/atBerth(=5) split fires — without this, EVERY Marinesia-sourced
// vessel gets navStatus=undefined and both buckets read 0. Unknown → undefined (never a wrong
// code: a mislabeled vessel falls back to the speed test, not miscounted as anchored/berthed).
function marinesiaStatusToNavStatus(status) {
  if (status == null || status === '') return undefined;
  const n = Number(status); // passthrough: already a numeric AIS code (or its numeric string)
  if (Number.isInteger(n) && n >= 0 && n <= 15 && String(status).trim() !== '') return n;
  switch (String(status).trim().toLowerCase()) {
    case 'under way using engine': case 'underway using engine': return 0;
    case 'at anchor': case 'anchored': case 'anchor': return 1;
    case 'not under command': return 2;
    case 'restricted manoeuvrability': case 'restricted maneuverability': case 'restricted manoeuverability': return 3;
    case 'constrained by her draught': case 'constrained by draught': case 'constrained by her draft': case 'constrained by draft': return 4;
    case 'moored': case 'berthed': return 5;
    case 'aground': return 6;
    case 'engaged in fishing': case 'fishing': return 7;
    case 'under way sailing': case 'underway sailing': case 'sailing': return 8;
    case 'power-driven vessel towing astern': case 'towing astern': return 11;
    case 'power-driven vessel pushing ahead or towing alongside': case 'pushing ahead or towing alongside': return 12;
    case 'ais-sart is active': case 'ais-sart': case 'sart': case 'mob': case 'epirb': return 14;
    case 'undefined': case 'not defined': case 'default': return 15;
    default: return undefined; // unknown label → let isStopped fall back to speed
  }
}

const numOrUndef = (x) => {
  if (x == null) return undefined;
  const n = Number(x);
  return Number.isFinite(n) ? n : undefined;
};

/** Map one Marinesia vessel object to our internal vessel shape, or null. */
function normalizeMarinesiaVessel(raw, now = Date.now()) {
  if (!raw || raw.mmsi == null || raw.mmsi === '') return null;
  const length = (Number(raw.a) || 0) + (Number(raw.b) || 0);
  const beam = (Number(raw.c) || 0) + (Number(raw.d) || 0);
  // ts has no timezone; Marinesia reports UTC, so pin it to UTC.
  const tsMs = raw.ts ? Date.parse(`${raw.ts}Z`) : NaN;
  return {
    mmsi: String(raw.mmsi),
    name: raw.name || '',
    imo: raw.imo ? String(raw.imo) : '',
    shipType: marinesiaTypeToShipType(raw.type),
    lat: numOrUndef(raw.lat),
    lon: numOrUndef(raw.lng),
    speed: numOrUndef(raw.sog),
    course: numOrUndef(raw.cog),
    heading: numOrUndef(raw.hdt),
    navStatus: marinesiaStatusToNavStatus(raw.status),
    destination: String(raw.dest || '').trim(),
    etaAis: raw.eta || '',
    draught: Number.isFinite(raw.draught) && raw.draught > 0 ? raw.draught : undefined,
    length: length > 0 ? length : undefined,
    beam: beam > 0 ? beam : undefined,
    timestamp: Number.isFinite(tsMs) ? tsMs : now,
  };
}

// Merge a normalized Marinesia vessel over an existing vesselStatic record.
//
// STATIC IDENTITY (name/imo/type/dims, and call sign which Marinesia lacks) is
// preserved when the new row omits it — so a poll missing those never erases
// richer aisstream- or earlier-poll-derived data.
//
// VOYAGE DATA (destination/ETA) is dynamic and CLEARABLE. It's treated as one
// atomic snapshot taken from whichever record carries the newest VOYAGE
// timestamp (`voyageTs`) — NOT the general freshness timestamp. Tracking voyage
// time separately matters because the two providers stamp on different clocks
// (aisstream uses receipt Date.now(); Marinesia carries the AIS report `ts`,
// which lags), so a record's general timestamp can be newer than the voyage
// value it holds. Gating on voyageTs means: the newest voyage snapshot wins,
// including clears, and an older row (empty OR non-empty) never overrides a newer
// one — so a cleared/changed ferry can't get stuck on a stale destination.
// (Records written by the aisstream static path have no voyageTs; we fall back
// to their general timestamp, which is its receipt time — a fine proxy.)
function mergeVesselStatic(prev, v, now = Date.now()) {
  const p = prev || {};
  const keep = (next, old) => (next != null && next !== '' ? next : old);
  const vTs = Number.isFinite(v.timestamp) ? v.timestamp : now;
  const prevVoyageTs = Number.isFinite(p.voyageTs) ? p.voyageTs
    : (Number.isFinite(p.timestamp) ? p.timestamp : -Infinity);

  // Take the incoming voyage snapshot only if it's at least as new as the stored
  // one; otherwise keep the prior voyage state (and its timestamp).
  const voyageWins = vTs >= prevVoyageTs;
  const destination = voyageWins ? (v.destination || '') : (p.destination || '');
  const etaAis = voyageWins ? (v.etaAis || '') : (p.etaAis || '');
  const voyageTs = voyageWins ? vTs : prevVoyageTs;

  return {
    mmsi: v.mmsi,
    name: keep(v.name, p.name) || '',
    shipType: v.shipType != null ? v.shipType : p.shipType,
    imo: keep(v.imo, p.imo) || '',
    destination,
    callSign: p.callSign || '',
    draught: v.draught != null ? v.draught : p.draught,
    length: v.length != null ? v.length : p.length,
    beam: v.beam != null ? v.beam : p.beam,
    etaAis,
    voyageTs,
    // General freshness timestamp stays monotonic (used for pruning), independent
    // of which voyage snapshot won.
    timestamp: Math.max(vTs, Number.isFinite(p.timestamp) ? p.timestamp : vTs),
  };
}

// Region geography is DERIVED FROM THE PORT REGISTRY, not hand-written. It used to be a single
// hardcoded box over Italian waters, which is why every non-Italian port went dark whenever
// aisstream did: the fallback simply never looked there, and no launch step made that visible.
// Deriving it means a country added to the registry gets fallback tiles automatically.
const portData = require('../src/config/maritime-ports.data.json');

// Grown around each country's own ports so vessels are seen on APPROACH, not just alongside
// (~0.6° ≈ 65 km, comfortably more than the widest at-port radius).
const REGION_MARGIN_DEG = 0.6;
// Cap on a single tile's span. The endpoint truncates at 2000 vessels per box with NO pagination
// and no signal in the payload, so an oversized tile silently returns an arbitrary subset.
//
// These were originally sized to the AREA of the Italian 3x3 (4.0 x 4.5). That was the wrong
// axis: what fills a tile is DENSITY, not area, and northern European waters are far denser than
// the Tyrrhenian. Measured live on 2026-08-01, vessels per square degree:
//
//   GB  Channel/Thames   227/deg^2   (1535 in 6.76 deg^2)
//   ES  Alboran/Gibraltar 169/deg^2  (1911 in 11.33 deg^2 — 96% of cap)
//   NL  Rotterdam/Dover  >140/deg^2  (2000 in 14.24 deg^2 — AT CAP, truncated)
//   IT  busiest tile     112/deg^2   (1310 in 11.71 deg^2)
//
// 2.5 x 2.5 (6.25 deg^2) clears the cap for ES, GB, IT and PT — ES drops from 96% of cap to 56%,
// which was the most urgent case since it would have truncated on any busy day.
//
// IT DOES NOT FIX THE NETHERLANDS, and that is not a tuning oversight. Measured the same day:
//
//   Rotterdam mouth, 1.00 deg^2 -> 2000 vessels (capped)
//   Rotterdam mouth, 0.49 deg^2 -> 1808 vessels  => ~3700/deg^2
//
// Roughly 16x the Channel's density. Staying under the cap there needs ~0.38 deg^2 tiles, and
// applying that resolution to these country-sized bounding boxes yields ~677 tiles — a 2.4 HOUR
// sweep at the fixed 5 req/min. So the country-bbox grid cannot cover the busiest port at any
// workable sweep time; two of the four Dutch tiles still return exactly 2000, Rotterdam's among
// them. The fix is to tile around PORTS rather than countries (~31-43 small boxes, ~7-9 min
// sweep) — a redesign, tracked separately. This constant is a real but PARTIAL improvement.
//
// Cost: more tiles means a longer round-robin sweep, NOT more requests — the poll interval is
// fixed by the 5 req/min rate limit either way, so quota is unchanged. Only worst-case tile age
// grows (5.4 -> 11.3 min), and MARINESIA_STALE_MS in the relay derives from the tile count, so it
// tracks this automatically.
const TILE_MAX_LAT_DEG = 2.5;
const TILE_MAX_LON_DEG = 2.5;
// Asserted in tests so a future span change can't silently re-create an even larger truncating
// tile. Note this bounds AREA, which is necessary but — as the Dutch case proves — not sufficient.
const MAX_TILE_AREA_DEG2 = TILE_MAX_LAT_DEG * TILE_MAX_LON_DEG;

/** Split a bbox into a rows×cols grid of sub-boxes. */
function makeGrid(bbox, rows, cols) {
  const tiles = [];
  const latStep = (bbox.lat_max - bbox.lat_min) / rows;
  const lonStep = (bbox.long_max - bbox.long_min) / cols;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      tiles.push({
        lat_min: bbox.lat_min + r * latStep,
        lat_max: bbox.lat_min + (r + 1) * latStep,
        long_min: bbox.long_min + c * lonStep,
        long_max: bbox.long_min + (c + 1) * lonStep,
      });
    }
  }
  return tiles;
}

/** Bounding box around a country's commercial ports, grown by REGION_MARGIN_DEG. */
function bboxForPorts(ports) {
  const lats = ports.map((p) => p.lat);
  const lons = ports.map((p) => p.lon);
  return {
    lat_min: Math.min(...lats) - REGION_MARGIN_DEG,
    lat_max: Math.max(...lats) + REGION_MARGIN_DEG,
    long_min: Math.min(...lons) - REGION_MARGIN_DEG,
    long_max: Math.max(...lons) + REGION_MARGIN_DEG,
  };
}

/**
 * One tile grid per covered country, keyed by country code. Regions may overlap where countries
 * adjoin (Portugal sits partly inside Spain's box) — that costs a duplicate upsert, never a gap.
 */
function buildRegions(ports) {
  const byCountry = new Map();
  for (const p of ports) {
    if (!p.commercial || !Number.isFinite(p.lat) || !Number.isFinite(p.lon)) continue;
    if (!byCountry.has(p.country)) byCountry.set(p.country, []);
    byCountry.get(p.country).push(p);
  }
  return [...byCountry.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([country, ps]) => {
    const bbox = bboxForPorts(ps);
    const rows = Math.max(1, Math.ceil((bbox.lat_max - bbox.lat_min) / TILE_MAX_LAT_DEG));
    const cols = Math.max(1, Math.ceil((bbox.long_max - bbox.long_min) / TILE_MAX_LON_DEG));
    return { country, bbox, tiles: makeGrid(bbox, rows, cols) };
  });
}

const MARINESIA_REGIONS = buildRegions(portData.ports);
// Flattened sweep order. Tile INDEX is the coverage key (see tileIndexFor), so this order is the
// contract between the poller's per-tile success map and per-port coverage.
const MARINESIA_TILES = MARINESIA_REGIONS.flatMap((r) => r.tiles);

/**
 * Index of the tile containing (lat, lon), or -1 if outside the grid. Bounds are inclusive, so a
 * point on a shared tile edge resolves to the first (lowest-index) matching tile — deterministic,
 * and harmless: both candidate tiles belong to the same sweep. Powers per-TILE coverage (a port is
 * Marinesia-covered only if ITS tile polled successfully recently, not just any tile).
 */
function tileIndexFor(tiles, lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return -1;
  for (let i = 0; i < tiles.length; i++) {
    const t = tiles[i];
    if (lat >= t.lat_min && lat <= t.lat_max && lon >= t.long_min && lon <= t.long_max) return i;
  }
  return -1;
}

/** Fetch one tile. Returns the raw vessel array (possibly empty). Throws on error. */
async function fetchTile(tile, key, fetchImpl = fetch) {
  const qs = new URLSearchParams({
    key,
    lat_min: String(tile.lat_min),
    lat_max: String(tile.lat_max),
    long_min: String(tile.long_min),
    long_max: String(tile.long_max),
  });
  const res = await fetchImpl(`${AREA_URL}?${qs}`, { headers: { Accept: 'application/json' } });
  const body = await res.text();
  let json;
  // Keep a snippet of the body: a 403 from the edge (expired plan / blocked account) is an HTML
  // page, and discarding it cost ten days of "why is the fallback dark?" — the error said only
  // "non-JSON response (HTTP 403)", which reads like a parser bug rather than an account problem.
  try { json = JSON.parse(body); } catch {
    throw new Error(`Marinesia non-JSON response (HTTP ${res.status}): ${body.slice(0, 160).replace(/\s+/g, ' ')}`);
  }
  // An EMPTY box answers 404 {"error":true,"message":"No data found"}. That is a successful poll of
  // a box with no vessels, not a failure — and since the grid is derived from a bbox around each
  // country's ports, some tiles are entirely inland (central Spain has one) and answer this on every
  // single sweep. Treating it as an error meant tilesSeen could never reach tileCount, so
  // relayFreshness kept `warming` true FOREVER, marinesiaFresh() never returned true, and the whole
  // fallback could never engage — one landlocked tile silently disabling coverage for five countries.
  if (res.status === 404 && json && /no data found/i.test(String(json.message || ''))) return [];
  if (!res.ok || json.error) throw new Error(`Marinesia error (HTTP ${res.status}): ${json.message || body.slice(0, 120)}`);
  return Array.isArray(json.data) ? json.data : [];
}

module.exports = {
  AREA_URL, VESSEL_CAP, MAX_TILE_AREA_DEG2, MARINESIA_TILES, MARINESIA_REGIONS, bboxForPorts, buildRegions,
  marinesiaTypeToShipType, marinesiaStatusToNavStatus, normalizeMarinesiaVessel, mergeVesselStatic, makeGrid, tileIndexFor, fetchTile,
};
