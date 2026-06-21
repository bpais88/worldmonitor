// Pure incident classification for the monitoring agent.
//
// Turns the current set of flagged ferries (+ delay reasons) plus the agent's
// memory of what it already alerted into: which to ping now (new / escalated),
// which have resolved, and the next memory state. No I/O — fully unit-tested.

/** Max reason confidence on an incident (0 if none). */
function maxConfidence(incident) {
  const rs = incident.reasons || [];
  return rs.reduce((m, r) => Math.max(m, Number.isFinite(r.confidence) ? r.confidence : 0), 0);
}

/** Coarse severity band: 0 low, 1 notable, 2 high. */
export function severityBand(incident) {
  if (incident.stalled) return 2;
  const conf = maxConfidence(incident);
  if (conf >= 0.7) return 2;
  if (conf >= 0.6 || (incident.etaGrowthMin ?? 0) >= 30) return 1;
  return 0;
}

/** Worth a real-time ping (vs digest-only). */
export function isSignificant(incident) {
  return severityBand(incident) >= 1;
}

/** Distinct reason kinds on an incident, for escalation detection. */
function reasonKinds(incident) {
  return [...new Set((incident.reasons || []).map((r) => `${r.source}:${r.kind}`))].sort();
}

function hasNewKind(kinds, prevKinds) {
  const prev = new Set(prevKinds || []);
  return kinds.some((k) => !prev.has(k));
}

/**
 * Classify current incidents against memory.
 * @param current  flagged incidents this tick
 * @param memMap   Map<mmsi, { firstSeenTs, band, kinds, lastPingedTs }>
 * @returns { pings:[{incident,kind}], resolutions:[mmsi], nextMem:Map }
 */
export function classifyIncidents(current, memMap, now = Date.now()) {
  const prevMem = memMap instanceof Map ? memMap : new Map();
  const pings = [];
  const nextMem = new Map();
  const seen = new Set();

  for (const incident of current) {
    const key = incident.mmsi;
    seen.add(key);
    const prev = prevMem.get(key);
    const sig = isSignificant(incident);
    const band = severityBand(incident);
    const kinds = reasonKinds(incident);

    if (!prev) {
      if (sig) pings.push({ incident, kind: 'new' });
      nextMem.set(key, { name: incident.name, firstSeenTs: now, band, kinds, lastPingedTs: sig ? now : null });
    } else {
      const escalated = sig && (band > prev.band || hasNewKind(kinds, prev.kinds));
      if (escalated) pings.push({ incident, kind: 'escalated' });
      nextMem.set(key, {
        name: incident.name,
        firstSeenTs: prev.firstSeenTs,
        band,
        kinds,
        lastPingedTs: escalated ? now : prev.lastPingedTs,
      });
    }
  }

  // Anything in memory but no longer flagged has resolved (keep its name).
  const resolutions = [];
  for (const [key, prev] of prevMem) {
    if (!seen.has(key)) resolutions.push({ mmsi: key, name: prev.name });
  }

  return { pings, resolutions, nextMem };
}
