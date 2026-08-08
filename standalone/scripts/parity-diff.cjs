'use strict';

// Parity harness — replay identical requests at two relays and diff the JSON.
//
// This is the cutover gate that characterization tests cannot be: those assert the new relay
// against a contract I WROTE DOWN, which bakes in whatever I misread. This asserts it against
// the predecessor's actual live output, request for request.
//
// Usage:
//   node scripts/parity-diff.cjs --old http://localhost:3999 --new http://localhost:3004 \
//     [--old-key K] [--new-key K] [--json report.json]
//
// Volatile fields (clocks, uptimes, ages) are normalized before comparison — see VOLATILE. Every
// normalization is a deliberate blind spot, so they are listed in the report rather than hidden.
// Exit code 0 = parity, 1 = differences found, 2 = harness/transport failure.

const VOLATILE = [
  'generatedAt', 'refreshedAt', 'ts', 'updatedAt', 'contextAsOf', 'lastPollAt',
  'uptimeSec', 'tileAgesSec', 'messages', 'startedAt', 'timestamp', 'etaTs', 'voyageTs',
  // Process memory drifts between two servers doing different work; comparing it would fail on
  // every run for no signal.
  'rss', 'heapUsed', 'heapTotal', 'lastSnapshotAt',
];

// DELIBERATE divergences from the predecessor. Every entry is a decision, not a defect — listing
// them here keeps the report actionable (real drift stays loud) and keeps the decisions reviewable
// in one place. A regex matches against `${path} ${diffPath}`.
const ACCEPTED = [
  // The fork's relay also hosted worldmonitor's tenants; this product never had them.
  [/^\/health body\.(oref|cache|opensky)/, 'tenant-only state (oref/opensky/rss caches) — endpoints not ported'],
  [/^\/metrics body\.(opensky|lifetime|windowSeconds)/, 'tenant-only metrics — endpoints not ported'],
  // The predecessor buffered aisstream frames through a drain queue sized for a shared process.
  // This relay applies frames directly, so the queue counters have nothing to report.
  [/^\/metrics body\.ais\.(queueMax|currentQueue|drops|dropsPerSec|upstreamPaused)/, 'no drain queue — frames applied directly'],
  [/^\/metrics body\.(ais\.(connected|tracked)|delays|marinesia)/, 'added: freight-relevant metrics the fork lacked'],
  [/^\/health body\.(aisKey|clients|densityZones|droppedMessages)/, 'fork-era ingest plumbing (key pool, ws clients, density grid) not carried over'],
  [/^\/health header\.cache-control/, 'health is explicitly no-store here; the fork left it uncached by omission'],
  [/^\/health body\.telegram/, 'tenant-only: the fork\'s Telegram CHANNEL scraper (not Marco\'s bot) — not ported'],
  [/^\/health body\.rateLimit$/, 'reshaped: per-route limits live in the kernel, not a per-tenant table'],
  [/^\/health body\.(delays|disruptions|tracked)$/, 'added: freight state the fork surfaced only on /metrics or not at all'],
  [/^\/health body\.auth\./, 'reshaped: auth reports {authHeader, required}; the fork also reported Vercel-preview origin handling it no longer needs'],
  [/^\/health body\.(db|upstreamPaused)$/, 'added/removed: explicit db flag; no upstream pause (no drain queue)'],
  [/^\/metrics body\.portHistory$/, 'added: snapshot/event counters the fork only exposed on /health'],
  [/^\/ais\/port-history body\.db$/, 'added: explicit db flag so callers can tell fallback from durable'],
  [/^\/ais\/port-history body\.snapshots\[\d+\]\.ports\[\d+\]\.congestionRel/, 'added: snapshots carry congestionRel too (one status path, not two)'],
];

const acceptedReason = (path, diffPath) => {
  const key = `${path} ${diffPath}`;
  for (const [re, why] of ACCEPTED) if (re.test(key)) return why;
  return null;
};

// Paths compared on every run. Query strings included so filters are exercised too.
const PATHS = [
  '/health',
  '/metrics',
  '/ais/ports',
  '/ais/vessels?limit=5',
  '/ais/vessels?freight=1&limit=5',
  '/ais/vessels?types=cargo&limit=5',
  '/ais/geofences',
  '/ais/port-history',
  '/ais/port-series?port=genoa',
  '/ais/voyages/daily?days=3',
  '/ais/trip?id=1',
  '/ais/vessel-profile?mmsi=1',
  '/ais/port-profile?port=genoa',
  '/ais/disruptions',
  '/ais/disruptions?country=PT',
];

/** Recursively drop volatile keys and sort arrays of objects by a stable identity. */
function normalize(value) {
  if (Array.isArray(value)) {
    const items = value.map(normalize);
    // Order can legitimately differ for equal-ranked rows; sort by a stable projection.
    return items.slice().sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).sort()) {
      if (VOLATILE.includes(k)) continue;
      out[k] = normalize(value[k]);
    }
    return out;
  }
  return value;
}

/** Structural diff -> array of {path, old, new}. */
function diff(a, b, path = '', acc = []) {
  const ta = a === null ? 'null' : Array.isArray(a) ? 'array' : typeof a;
  const tb = b === null ? 'null' : Array.isArray(b) ? 'array' : typeof b;
  if (ta !== tb) { acc.push({ path: path || '/', old: `<${ta}>`, new: `<${tb}>` }); return acc; }
  if (ta === 'array') {
    if (a.length !== b.length) acc.push({ path: `${path}.length`, old: a.length, new: b.length });
    for (let i = 0; i < Math.min(a.length, b.length); i++) diff(a[i], b[i], `${path}[${i}]`, acc);
    return acc;
  }
  if (ta === 'object') {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (!(k in a)) { acc.push({ path: `${path}.${k}`, old: '<missing>', new: summarize(b[k]) }); continue; }
      if (!(k in b)) { acc.push({ path: `${path}.${k}`, old: summarize(a[k]), new: '<missing>' }); continue; }
      diff(a[k], b[k], `${path}.${k}`, acc);
    }
    return acc;
  }
  if (a !== b) acc.push({ path: path || '/', old: a, new: b });
  return acc;
}

const summarize = (v) => {
  const s = JSON.stringify(v);
  return s && s.length > 60 ? `${s.slice(0, 57)}...` : s;
};

async function probe(base, path, key, authHeader = 'x-relay-key') {
  const headers = key ? { [authHeader]: key } : {};
  const res = await fetch(`${base}${path}`, { headers });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = { __unparseable: text.slice(0, 200) }; }
  return {
    status: res.status,
    contentType: res.headers.get('content-type'),
    cacheControl: res.headers.get('cache-control'),
    body,
  };
}

async function run(opts) {
  const results = [];
  for (const path of PATHS) {
    let oldRes; let newRes;
    try {
      [oldRes, newRes] = await Promise.all([
        probe(opts.old, path, opts.oldKey),
        probe(opts.new, path, opts.newKey),
      ]);
    } catch (e) {
      results.push({ path, transportError: e.message });
      continue;
    }
    const all = [
      ...(oldRes.status !== newRes.status ? [{ path: 'status', old: oldRes.status, new: newRes.status }] : []),
      ...(oldRes.cacheControl !== newRes.cacheControl ? [{ path: 'header.cache-control', old: oldRes.cacheControl, new: newRes.cacheControl }] : []),
      ...diff(normalize(oldRes.body), normalize(newRes.body), 'body'),
    ];
    const differences = [];
    const accepted = [];
    for (const d of all) {
      const why = acceptedReason(path, d.path);
      if (why) accepted.push({ ...d, why }); else differences.push(d);
    }
    results.push({ path, status: [oldRes.status, newRes.status], differences, accepted });
  }
  return results;
}

function report(results) {
  let differing = 0;
  let failed = 0;
  for (const r of results) {
    if (r.transportError) { failed++; console.log(`  ERROR  ${r.path} — ${r.transportError}`); continue; }
    if (!r.differences.length) {
      const note = r.accepted?.length ? `  (${r.accepted.length} accepted divergence${r.accepted.length === 1 ? '' : 's'})` : '';
      console.log(`  ok     ${r.path}${note}`);
      continue;
    }
    differing++;
    console.log(`  DIFF   ${r.path}  (${r.differences.length} difference${r.differences.length === 1 ? '' : 's'})`);
    for (const d of r.differences.slice(0, 12)) {
      console.log(`           ${d.path}: old=${summarize(d.old)}  new=${summarize(d.new)}`);
    }
    if (r.differences.length > 12) console.log(`           ... ${r.differences.length - 12} more`);
  }
  console.log(`\n  ${results.length - differing - failed}/${results.length} identical · ${differing} differing · ${failed} errored`);
  console.log(`  normalized away (never compared): ${VOLATILE.join(', ')}`);
  const reasons = new Map();
  for (const r of results) for (const a of r.accepted || []) reasons.set(a.why, (reasons.get(a.why) || 0) + 1);
  if (reasons.size) {
    console.log('\n  Accepted divergences (deliberate, see ACCEPTED in this file):');
    for (const [why, n] of reasons) console.log(`    ${String(n).padStart(3)}x  ${why}`);
  }
  return { differing, failed };
}

function parseArgs(argv) {
  const get = (flag, def) => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
  };
  return {
    old: get('--old', 'http://localhost:3999'),
    new: get('--new', 'http://localhost:3004'),
    oldKey: get('--old-key', process.env.OLD_RELAY_KEY || ''),
    newKey: get('--new-key', process.env.NEW_RELAY_KEY || ''),
    json: get('--json', ''),
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  console.log(`\nParity diff\n  old: ${opts.old}\n  new: ${opts.new}\n`);
  const results = await run(opts);
  const { differing, failed } = report(results);
  if (opts.json) {
    require('node:fs').writeFileSync(opts.json, JSON.stringify({ opts: { old: opts.old, new: opts.new }, results }, null, 2));
    console.log(`  report written to ${opts.json}`);
  }
  process.exit(failed ? 2 : differing ? 1 : 0);
}

if (require.main === module) main();

module.exports = { normalize, diff, run, PATHS, VOLATILE };
