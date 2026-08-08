'use strict';

// Pure query/filter logic for the relay's /ais/vessels endpoint.
//
// Extracted from ais-relay.cjs so it can be unit-tested without starting the
// relay server or a live AIS connection. The relay requires this module and
// uses these functions directly, so the tests exercise the real code path.

// Bucket an AIS ship type code (0-99) into a coarse commercial category.
function shipTypeCategory(shipType) {
  const t = Number(shipType);
  if (!Number.isFinite(t)) return 'other';
  if (t >= 60 && t <= 69) return 'passenger';
  if (t >= 70 && t <= 79) return 'cargo';
  if (t >= 80 && t <= 89) return 'tanker';
  if (t >= 40 && t <= 49) return 'hsc'; // high-speed craft (many fast ferries)
  return 'other';
}

// Parse a "swLat,swLon,neLat,neLon" bbox param into normalized bounds, or null.
function parseBbox(bboxParam) {
  if (!bboxParam) return null;
  const parts = String(bboxParam).split(',').map(Number);
  if (parts.length !== 4 || !parts.every(Number.isFinite)) return null;
  const [aLat, aLon, bLat, bLon] = parts;
  return {
    swLat: Math.min(aLat, bLat),
    neLat: Math.max(aLat, bLat),
    swLon: Math.min(aLon, bLon),
    neLon: Math.max(aLon, bLon),
  };
}

// Parse a "passenger,hsc" types param into a Set, or null (= all types).
function parseTypes(typesParam) {
  if (!typesParam) return null;
  const set = new Set(
    String(typesParam).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  );
  return set.size > 0 ? set : null;
}

// Clamp a limit param to [1, max], defaulting when absent/invalid.
function clampLimit(limitParam, { def, max }) {
  return Math.min(max, Math.max(1, Number(limitParam) || def));
}

function inBounds(v, bounds) {
  return !(v.lat < bounds.swLat || v.lat > bounds.neLat || v.lon < bounds.swLon || v.lon > bounds.neLon);
}

// Build the /ais/vessels response array from the live vessel + static maps.
// Merges static data (destination, IMO, fallback ship type) per vessel.
// `resolveOperator(name)` (optional) attaches the authoritative operator id/name
// so the API is the single source of truth. `wantOperator` (optional, lowercase
// operator id) restricts the result to one operator server-side.
function buildVesselList(vessels, vesselStatic, { bounds, wantTypes, limit, isFreight, resolveOperator, wantOperator }) {
  const out = [];
  for (const [mmsi, v] of vessels) {
    if (bounds && !inBounds(v, bounds)) continue;

    const stat = vesselStatic.get(mmsi);
    const shipType = Number.isFinite(v.shipType)
      ? v.shipType
      : (stat && Number.isFinite(stat.shipType) ? stat.shipType : undefined);
    const category = shipTypeCategory(shipType);
    if (wantTypes && !wantTypes.has(category)) continue;

    const name = v.name || (stat && stat.name) || '';
    // Freight filter (research-backed): IMO registry override, else cargo + RoPax-by-operator.
    if (isFreight && !isFreight(shipType, name, stat && stat.imo)) continue;

    const operator = resolveOperator ? resolveOperator(name) : null;
    if (wantOperator && (!operator || operator.id !== wantOperator)) continue;

    out.push({
      mmsi,
      name,
      lat: v.lat,
      lon: v.lon,
      speed: v.speed,
      course: v.course,
      heading: v.heading,
      navStatus: v.navStatus,
      shipType,
      category,
      operatorId: operator ? operator.id : '',
      operatorName: operator ? operator.name : '',
      imo: stat ? stat.imo : '',
      destination: stat ? stat.destination : '',
      callSign: stat ? (stat.callSign || '') : '',
      draught: stat ? stat.draught : undefined,
      length: stat ? stat.length : undefined,
      beam: stat ? stat.beam : undefined,
      etaAis: stat ? (stat.etaAis || '') : '',
      timestamp: v.timestamp,
    });
    if (out.length >= limit) break;
  }
  return out;
}

module.exports = { shipTypeCategory, parseBbox, parseTypes, clampLimit, buildVesselList };
