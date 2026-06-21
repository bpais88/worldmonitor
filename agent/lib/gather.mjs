// Fetch the current flagged ferries from the relay and normalise them into
// incidents. Reuses the tested ferry-eta resolver to add destination name +
// region (not present in the raw /ais/vessels payload).

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { resolveDestinationPort } = require('../../scripts/ferry-eta.cjs');

const ITALY_BBOX = '35,6,46.5,19.5';

/** GET the relay vessels and return only flagged ones, as incidents. */
export async function fetchIncidents(relayBase, sharedSecret, bbox = ITALY_BBOX) {
  const url = `${relayBase.replace(/\/$/, '')}/ais/vessels?bbox=${bbox}&types=passenger,hsc&limit=3000`;
  const res = await fetch(url, {
    headers: { Accept: 'application/json', ...(sharedSecret ? { 'x-relay-key': sharedSecret } : {}) },
  });
  if (!res.ok) throw new Error(`relay ${res.status}`);
  const data = await res.json();
  const out = [];
  for (const v of data.vessels || []) {
    const d = v.delay;
    if (!d || (!d.slipping && !d.stalled)) continue;
    const port = resolveDestinationPort(v.destination);
    out.push({
      mmsi: String(v.mmsi),
      name: (v.name || `MMSI ${v.mmsi}`).trim(),
      destName: port ? port.name : null,
      region: port ? port.region : null,
      stalled: !!d.stalled,
      etaGrowthMin: Number.isFinite(d.etaGrowthMin) ? d.etaGrowthMin : 0,
      reasons: Array.isArray(d.reasons) ? d.reasons : [],
    });
  }
  return out;
}
