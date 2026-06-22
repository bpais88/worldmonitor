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
    navStatus: numOrUndef(raw.status),
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
// VOYAGE DATA (destination/ETA) is dynamic and CLEARABLE, so it takes the latest
// value as-is, including empty. Marinesia always includes `dest`, so '' means
// "no destination", not "omitted" — preserving a stale port would leave an
// arrived/cleared vessel resolving the old port and being falsely marked stalled.
function mergeVesselStatic(prev, v, now = Date.now()) {
  const p = prev || {};
  const keep = (next, old) => (next != null && next !== '' ? next : old);
  return {
    mmsi: v.mmsi,
    name: keep(v.name, p.name) || '',
    shipType: v.shipType != null ? v.shipType : p.shipType,
    imo: keep(v.imo, p.imo) || '',
    destination: v.destination || '', // latest wins (clearable voyage data)
    callSign: p.callSign || '',
    draught: v.draught != null ? v.draught : p.draught,
    length: v.length != null ? v.length : p.length,
    beam: v.beam != null ? v.beam : p.beam,
    etaAis: v.etaAis || '',            // latest wins (clearable voyage data)
    timestamp: v.timestamp || now,
  };
}

// Italian waters: Ligurian/Tyrrhenian/Adriatic/Ionian + Sicily channel.
const ITALY_BBOX = { lat_min: 36, lat_max: 46, long_min: 6, long_max: 19 };

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

// Default 3×3 grid over Italian waters — 9 tiles, each well under the 2000 cap
// at observed densities; a full sweep is 9 requests (~108s at 5 req/min).
const ITALY_TILES = makeGrid(ITALY_BBOX, 3, 3);

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
  try { json = JSON.parse(body); } catch { throw new Error(`Marinesia non-JSON response (HTTP ${res.status})`); }
  if (!res.ok || json.error) throw new Error(`Marinesia error (HTTP ${res.status}): ${json.message || body.slice(0, 120)}`);
  return Array.isArray(json.data) ? json.data : [];
}

module.exports = {
  AREA_URL, VESSEL_CAP, ITALY_BBOX, ITALY_TILES,
  marinesiaTypeToShipType, normalizeMarinesiaVessel, mergeVesselStatic, makeGrid, fetchTile,
};
