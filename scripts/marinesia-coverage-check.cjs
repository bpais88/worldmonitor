'use strict';

// One-shot Marinesia coverage probe. Hits the vessel/area (bounding-box)
// endpoint for Italian waters and reports what actually comes back: how many
// vessels, which fields, and whether ship type/name (needed for freight
// classification) are present. Makes EXACTLY ONE request (free tier is rate-
// limited, possibly 1/hour) so we don't waste the budget.
//
// Key is read from .marinesia-key (gitignored) or MARINESIA_API_KEY — never
// hard-coded.

const fs = require('fs');
const path = require('path');

function readKey() {
  if (process.env.MARINESIA_API_KEY) return process.env.MARINESIA_API_KEY.trim();
  try {
    return fs.readFileSync(path.join(__dirname, '..', '.marinesia-key'), 'utf8').trim();
  } catch { return ''; }
}

// Italian waters bounding box (Ligurian/Tyrrhenian/Adriatic/Ionian + Sicily).
const BBOX = { lat_min: 36, lat_max: 46, long_min: 6, long_max: 19 };
const BASE = 'https://api.marinesia.com/api/v2/vessel/area';

async function main() {
  const key = readKey();
  if (!key) { console.error('No key: set MARINESIA_API_KEY or create .marinesia-key'); process.exit(1); }

  const qs = new URLSearchParams({ key, ...Object.fromEntries(Object.entries(BBOX).map(([k, v]) => [k, String(v)])) });
  const url = `${BASE}?${qs}`;
  const masked = url.replace(encodeURIComponent(key), '***').replace(key, '***');
  console.log('GET', masked);

  let res, body;
  try {
    res = await fetch(url, { headers: { Accept: 'application/json' } });
    body = await res.text();
  } catch (e) {
    console.error('Request failed:', e.message);
    process.exit(1);
  }

  console.log('HTTP', res.status, res.statusText);
  console.log('--- raw body (first 2000 chars) ---');
  console.log(body.slice(0, 2000));

  let json;
  try { json = JSON.parse(body); } catch { console.log('(body is not JSON)'); return; }

  // Find the vessel array wherever it lives in the envelope.
  const arr = Array.isArray(json) ? json
    : Array.isArray(json.data) ? json.data
    : Array.isArray(json.vessels) ? json.vessels
    : Array.isArray(json.result) ? json.result
    : null;

  console.log('\n--- summary ---');
  if (!arr) { console.log('No vessel array found. Top-level keys:', Object.keys(json)); return; }
  console.log('vessel count:', arr.length);
  if (arr.length) {
    console.log('fields on first vessel:', Object.keys(arr[0]).join(', '));
    const hasType = arr.some(v => v.type != null || v.ship_type != null || v.shipType != null || v.vessel_type != null);
    const hasName = arr.some(v => v.name != null || v.ship_name != null);
    const hasImo = arr.some(v => v.imo != null);
    console.log('has ship type?', hasType, '| has name?', hasName, '| has imo?', hasImo);
    console.log('\nsample (up to 5):');
    for (const v of arr.slice(0, 5)) console.log(JSON.stringify(v));
  }
}

main();
