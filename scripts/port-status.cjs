'use strict';

// Per-port freight status, derived from our OWN live vessel data (no external
// call). For each port: how many freight vessels are stopped AT the port
// (waiting/berthed) and how many are INBOUND (under way with this port as their
// resolved destination), plus a congestion level. Powers the ports view / the
// "where do I see port congestion" question.
//
// Pure (port + vessel list + a destination resolver in, status out) so it
// unit-tests without I/O; the relay wires it over its live vessel map.

const { haversineKm } = require('./ferry-eta.cjs');

const DEFAULTS = {
  radiusKm: 8,           // "at the port" = within this of the terminal
  stoppedKnots: 1,       // at/below this counts as stopped
  freshMs: 30 * 60_000,  // ignore vessels that stopped reporting
  busyAt: 4,             // atPort >= this -> busy
  congestedAt: 8,        // atPort >= this -> congested
};

const NAV_AT_ANCHOR = 1;
const NAV_MOORED = 5;

function isStopped(v, stoppedKnots) {
  if (v.navStatus === NAV_AT_ANCHOR || v.navStatus === NAV_MOORED) return true;
  return Number.isFinite(v.speed) && v.speed <= stoppedKnots;
}

function congestionLevel(atPort, o) {
  if (atPort >= o.congestedAt) return 'congested';
  if (atPort >= o.busyAt) return 'busy';
  return 'clear';
}

/**
 * Status for one port. `resolveDest(destString) -> {portId}|null` maps a
 * vessel's AIS destination to a port id (use resolveDestinationPort). Pure.
 */
function computePortStatus(port, vessels, resolveDest, now = Date.now(), opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  let atPort = 0;
  let inbound = 0;
  for (const v of vessels || []) {
    if (!v) continue;
    if (Number.isFinite(v.timestamp) && now - v.timestamp > o.freshMs) continue;
    // At port: stopped within the radius.
    if (Number.isFinite(v.lat) && Number.isFinite(v.lon) &&
        haversineKm(v, port) <= o.radiusKm && isStopped(v, o.stoppedKnots)) {
      atPort++;
      continue;
    }
    // Inbound: destination resolves to this port and the vessel is under way.
    if (v.destination && Number.isFinite(v.speed) && v.speed > o.stoppedKnots) {
      const d = resolveDest && resolveDest(v.destination);
      if (d && d.portId === port.portId) inbound++;
    }
  }
  return {
    portId: port.portId,
    name: port.name,
    lat: port.lat,
    lon: port.lon,
    region: port.region || null,
    atPort,
    inbound,
    congestion: congestionLevel(atPort, o),
  };
}

/**
 * Status for every port. `ports` may be an ARRAY of port objects (each with an
 * `id`) — as in italy-ferries.data.json — or an object keyed by port id. The
 * emitted portId always comes from the port's own `id` (else the map key) so it
 * matches resolveDest()'s portId for inbound counting. `filter(port)` optionally
 * restricts which ports (e.g. commercial only). Ports without coords are skipped.
 * Sorted by congestion severity then atPort count, desc.
 */
function computeAllPortStatus(ports, vessels, resolveDest, now = Date.now(), opts = {}, filter = null) {
  const entries = Array.isArray(ports) ? ports.map((p) => [p && p.id, p]) : Object.entries(ports || {});
  const out = [];
  for (const [key, p] of entries) {
    if (!p) continue;
    if (filter && !filter(p)) continue;
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon)) continue;
    out.push(computePortStatus({ ...p, portId: p.id || key }, vessels, resolveDest, now, opts));
  }
  const rank = { congested: 2, busy: 1, clear: 0 };
  out.sort((a, b) => (rank[b.congestion] - rank[a.congestion]) || (b.atPort - a.atPort) || (b.inbound - a.inbound));
  return out;
}

function median(nums) {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

/**
 * Smooth each port's atPort over a rolling history (Map portId -> number[]) and
 * recompute congestion from the median — so transient poll noise can't flip a
 * port or jiggle the count. Mutates the ports (adds atPortRaw, overwrites atPort
 * + congestion) and the history Map. `n` = window length.
 */
function smoothPortStatus(ports, history, n = 5, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  for (const p of ports) {
    const h = history.get(p.portId) || [];
    h.push(p.atPort);
    while (h.length > n) h.shift();
    history.set(p.portId, h);
    const sm = median(h);
    p.atPortRaw = p.atPort;
    p.atPort = sm;
    p.congestion = congestionLevel(sm, o);
  }
  return ports;
}

module.exports = { computePortStatus, computeAllPortStatus, congestionLevel, median, smoothPortStatus, DEFAULTS };
