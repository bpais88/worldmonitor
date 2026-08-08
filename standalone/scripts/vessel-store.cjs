'use strict';

// Live vessel state for the freight relay — clean-room. Two maps, mirroring the
// data model the domain modules already expect (position rows + a static/voyage
// record merged via marinesia.mergeVesselStatic, which owns the newest-voyage-wins
// rules): `positions` is what the geometry math reads, `statics` carries identity
// + destination. Bounded by count and by report age.

const { mergeVesselStatic } = require('./marinesia.cjs');
const { isFreightVessel } = require('./ferry-eta.cjs');

const DEFAULTS = {
  maxVessels: 30_000,     // hard cap; oldest-report evicted beyond it
  staleMs: 60 * 60_000,   // a contact silent this long is pruned entirely
};

function makeVesselStore(opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const positions = new Map(); // mmsi -> {mmsi,name,lat,lon,speed,course,heading,navStatus,shipType,timestamp}
  const statics = new Map();   // mmsi -> merged static/voyage record (see mergeVesselStatic)

  function applyPosition(v, now = Date.now()) {
    if (!v || !v.mmsi || !Number.isFinite(v.lat) || !Number.isFinite(v.lon)) return;
    positions.set(String(v.mmsi), {
      mmsi: String(v.mmsi), name: v.name || '', lat: v.lat, lon: v.lon,
      speed: v.speed, course: v.course, heading: v.heading,
      navStatus: v.navStatus, shipType: v.shipType,
      timestamp: Number.isFinite(v.timestamp) ? v.timestamp : now,
    });
    if (positions.size > o.maxVessels) evictOldest();
  }

  function applyStatic(v, now = Date.now()) {
    if (!v || !v.mmsi) return;
    const key = String(v.mmsi);
    statics.set(key, mergeVesselStatic(statics.get(key), v, now));
  }

  /** One call for a fully-populated row (e.g. a Marinesia poll result). */
  function applyFull(v, now = Date.now()) {
    applyPosition(v, now);
    applyStatic(v, now);
  }

  function evictOldest() {
    let oldestKey = null; let oldestTs = Infinity;
    for (const [k, v] of positions) if (v.timestamp < oldestTs) { oldestTs = v.timestamp; oldestKey = k; }
    if (oldestKey) { positions.delete(oldestKey); statics.delete(oldestKey); }
  }

  function prune(now = Date.now()) {
    let removed = 0;
    for (const [k, v] of positions) {
      if (now - v.timestamp > o.staleMs) { positions.delete(k); statics.delete(k); removed++; }
    }
    return removed;
  }

  /** Freight subset (cargo + RoPax-by-operator + IMO registry), with destination merged in. */
  function freightList(now = Date.now(), freshMs = null) {
    const out = [];
    for (const [mmsi, v] of positions) {
      const s = statics.get(mmsi);
      const shipType = Number.isFinite(v.shipType) ? v.shipType : s?.shipType;
      if (!isFreightVessel(shipType, v.name || s?.name, s?.imo)) continue;
      if (freshMs != null && Number.isFinite(v.timestamp) && now - v.timestamp > freshMs) continue;
      out.push({ ...v, shipType, name: v.name || s?.name || '', destination: s?.destination || '' });
    }
    return out;
  }

  function boundingBox() {
    if (!positions.size) return null;
    let swLat = 90, swLon = 180, neLat = -90, neLon = -180;
    for (const v of positions.values()) {
      if (v.lat < swLat) swLat = v.lat; if (v.lat > neLat) neLat = v.lat;
      if (v.lon < swLon) swLon = v.lon; if (v.lon > neLon) neLon = v.lon;
    }
    return { swLat, swLon, neLat, neLon };
  }

  return { positions, statics, applyPosition, applyStatic, applyFull, prune, freightList, boundingBox };
}

module.exports = { makeVesselStore, DEFAULTS };
