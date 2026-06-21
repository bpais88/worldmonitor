#!/usr/bin/env node
// Equasis worklist generator.
//
// Equasis has no bulk API, so the IMO->ship-type registry
// (italy-ferries.data.json `imoRegistry`) is populated by hand. This script
// produces the *finite* worklist: the ambiguous PASSENGER vessels (60-69) seen
// in the live feed that have an IMO and aren't yet in the registry — i.e. the
// RoPax-vs-cruise cases the heuristic can't be sure about. Cargo is unambiguous
// freight and is skipped.
//
// For each, look it up on https://www.equasis.org (search by IMO) and read
// "Type of ship": "Passenger/Ro-Ro Cargo Ship" -> freight:true;
// "Passenger (Cruise) Ship" -> freight:false. Add the entry to imoRegistry.
//
// Env: RELAY_URL, RELAY_SHARED_SECRET.  Run: node scripts/equasis-worklist.mjs

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { resolveOperatorName } = require('./ferry-eta.cjs');
const data = require('../src/config/italy-ferries.data.json');

const RELAY = process.env.RELAY_URL || 'http://localhost:3004';
const SECRET = process.env.RELAY_SHARED_SECRET || '';
const BBOX = process.env.FERRY_BBOX || '35,6,46.5,19.5';
const registry = data.imoRegistry || {};

async function main() {
  const url = `${RELAY.replace(/\/$/, '')}/ais/vessels?bbox=${BBOX}&types=passenger&limit=3000`;
  const res = await fetch(url, { headers: { Accept: 'application/json', ...(SECRET ? { 'x-relay-key': SECRET } : {}) } });
  if (!res.ok) throw new Error(`relay ${res.status}`);
  const { vessels = [] } = await res.json();

  const rows = [];
  const seen = new Set();
  for (const v of vessels) {
    const t = Number(v.shipType);
    if (!(t >= 60 && t <= 69)) continue;          // passenger only (the ambiguous range)
    if (!v.imo || v.imo === '0' || seen.has(v.imo)) continue;
    if (Object.prototype.hasOwnProperty.call(registry, v.imo)) continue; // already verified
    seen.add(v.imo);
    const op = resolveOperatorName(v.name);
    rows.push({ imo: v.imo, name: (v.name || '').trim(), length: v.length || '', guess: op ? `${op} (freight-op)` : 'unknown operator' });
  }
  rows.sort((a, b) => (b.length || 0) - (a.length || 0));

  console.log(`# Equasis worklist — ${rows.length} ambiguous passenger vessels to verify`);
  console.log('# Look up each IMO at https://www.equasis.org -> "Type of ship":');
  console.log('#   "Passenger/Ro-Ro Cargo Ship" => freight:true ; "Passenger (Cruise) Ship" => false');
  console.log('# Then add to imoRegistry in src/config/italy-ferries.data.json.\n');
  console.log('IMO'.padEnd(10), 'LEN'.padEnd(6), 'CURRENT GUESS'.padEnd(26), 'NAME');
  for (const r of rows) {
    console.log(String(r.imo).padEnd(10), String(r.length).padEnd(6), r.guess.padEnd(26), r.name);
  }
  // Ready-to-edit JSON skeleton.
  console.log('\n# Skeleton (fill freight true/false, paste into imoRegistry):');
  const skel = {};
  for (const r of rows) skel[r.imo] = { freight: null, name: r.name };
  console.log(JSON.stringify(skel, null, 2));
}

main().catch((e) => { console.error('worklist failed:', e.message); process.exitCode = 1; });
