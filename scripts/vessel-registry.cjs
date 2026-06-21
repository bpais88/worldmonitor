'use strict';

// Persistent, accumulating vessel-identity registry (IMO -> classification).
//
// Vessel *identity* (type, operator, freight-or-not) is static per hull, so we
// determine it once and remember it instead of re-deriving on every message and
// losing it on every restart. Keyed on IMO (the durable id — MMSI reflagging/
// placeholders make it unreliable; see AIS_VESSEL_CLASSIFICATION_RESEARCH.md).
//
// Entry: { imo, name, shipType, operatorName, freight, verified, firstSeenTs,
//          lastSeenTs }. `verified` = an authoritative source (Equasis) set the
// freight verdict, which observed heuristics must not overwrite.
//
// Pure logic (registry is a Map passed in) so it unit-tests without I/O; the
// relay persists it to Upstash and reloads it on boot.

/** Record/refine a vessel observation. Mutates + returns the registry Map. */
function upsertVessel(registry, obs, now = Date.now()) {
  if (!obs || !obs.imo) return registry; // no durable key -> skip
  const prev = registry.get(obs.imo);
  const verified = !!(prev && prev.verified) || !!obs.verified;
  // freight: a verified verdict is sticky; otherwise take the new value, else keep prior.
  let freight;
  if (prev && prev.verified) freight = prev.freight;          // sticky verified
  else if (obs.verified) freight = obs.freight;               // new verified set
  else if (typeof obs.freight === 'boolean') freight = obs.freight;
  else freight = prev ? prev.freight : undefined;

  registry.set(obs.imo, {
    imo: obs.imo,
    name: obs.name || (prev && prev.name) || '',
    shipType: Number.isFinite(obs.shipType) ? obs.shipType : (prev && prev.shipType),
    operatorName: obs.operatorName || (prev && prev.operatorName) || '',
    freight,
    verified,
    firstSeenTs: prev ? prev.firstSeenTs : now,
    lastSeenTs: now,
  });
  return registry;
}

/** The remembered freight verdict for an IMO, or null if unknown/undecided. */
function registryFreight(registry, imo) {
  const e = imo && registry.get(imo);
  return e && typeof e.freight === 'boolean' ? e.freight : null;
}

/** Drop vessels not seen within ttlMs. Mutates + returns the registry. */
function pruneRegistry(registry, now = Date.now(), ttlMs = 30 * 24 * 3600_000) {
  for (const [imo, e] of registry) {
    if (!e || !Number.isFinite(e.lastSeenTs) || now - e.lastSeenTs > ttlMs) registry.delete(imo);
  }
  return registry;
}

function serializeRegistry(registry) {
  return Object.fromEntries(registry);
}
function deserializeRegistry(obj) {
  return new Map(Object.entries(obj || {}));
}

module.exports = {
  upsertVessel, registryFreight, pruneRegistry, serializeRegistry, deserializeRegistry,
};
