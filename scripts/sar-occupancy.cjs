'use strict';

// M6 prototype — Sentinel-1 SAR ship-occupancy snapshots for AIS-blind water (scope:
// assistant/DISRUPTION_SOURCES_SCOPE.md M6; satellite deep-research verdict 2026-07-17).
//
// WHY SAR: our aisstream feed has ZERO receivers in the Persian Gulf / Gulf of Oman, and
// satellite AIS is a sales-gated duopoly. But Sentinel-1 images the Gulf every 1-3 days and
// Microsoft's Planetary Computer serves pixel crops ANONYMOUSLY — ships are hard radar targets
// orders of magnitude brighter than sea clutter (verified 2026-07-19: Jebel Ali sea median 103,
// p99.9 = 181, ship returns 500-6300 on the same scale). Counting bright targets in a
// water-only box is a free, direct occupancy observation where AIS sees nothing.
//
// WHAT IT IS / ISN'T: an instantaneous snapshot per satellite pass — a LOWER BOUND on vessels
// present (adjacent ships can merge under bright-target sidelobe flares; ~50 m/px hides small
// craft), with no identity and no track. It complements the market-implied Hormuz signal
// (chokepoint-markets.cjs): markets price expectations, this observes water. Never present a
// count as "N ships" — say "N radar targets".
//
// AOI RULES: boxes must be WATER-ONLY (land is brighter than any ship) and clear of islets
// (static reflectors). Both shipped AOIs were verified against live imagery on 2026-07-19.
// Scenes that only graze an AOI are fetched over the intersection and reported with their
// coverage fraction — compare counts only across comparable coverage.
//
// Pure pixel/geometry logic is exported for tests; only searchScenes/fetchCrop touch the network.
// Run: node scripts/sar-occupancy.cjs [aoi] [--days N] [--json]   (aoi omitted = all AOIs)

const STAC_SEARCH_URL = 'https://planetarycomputer.microsoft.com/api/stac/v1/search';
const DATA_API_BASE = 'https://planetarycomputer.microsoft.com/api/data/v1/item/bbox';
const COLLECTION = 'sentinel-1-grd';
const TARGET_M_PER_PX = 50; // GRD IW is 10 m; 50 m/px keeps crops ~1 MB and big ships 4-8 px
const MAX_DIM = 1024;

const AOIS = [
  {
    id: 'jebel_ali_anchorage',
    name: 'Jebel Ali anchorage (offshore NW)',
    // Water-only box NW of Palm Jebel Ali; the outer anchorage where deep-sea traffic waits.
    bbox: [54.70, 25.05, 54.92, 25.33],
  },
  {
    id: 'hormuz_tss_north',
    name: 'Strait of Hormuz TSS (north of Musandam islets)',
    // Traffic-lane water north of the Quoin/Salamah islets (islets end ~26.42N — stay above).
    bbox: [56.25, 26.55, 56.75, 26.75],
  },
];

/** Parse a NumPy .npy buffer (v1/v2 header, little-endian uint16, C order). Pure. */
function parseNpy(buf) {
  if (buf.length < 10 || buf.toString('latin1', 1, 6) !== 'NUMPY') throw new Error('not an .npy buffer');
  const major = buf[6];
  const headerLen = major >= 2 ? buf.readUInt32LE(8) : buf.readUInt16LE(8);
  const dataOff = (major >= 2 ? 12 : 10) + headerLen;
  const header = buf.toString('latin1', major >= 2 ? 12 : 10, dataOff);
  const descr = /'descr':\s*'([^']+)'/.exec(header)?.[1];
  const shape = (/'shape':\s*\(([^)]*)\)/.exec(header)?.[1] || '')
    .split(',').map((s) => Number(s.trim())).filter(Number.isFinite);
  if (descr !== '<u2') throw new Error(`unsupported npy dtype ${descr} (expected <u2)`);
  if (/'fortran_order':\s*True/.test(header)) throw new Error('fortran-order npy unsupported');
  const count = shape.reduce((a, b) => a * b, 1);
  if (dataOff + count * 2 > buf.length) throw new Error('npy buffer shorter than header shape');
  // Copy to guarantee alignment (Buffer views may start at odd offsets).
  const data = new Uint16Array(count);
  for (let i = 0; i < count; i++) data[i] = buf.readUInt16LE(dataOff + i * 2);
  return { shape, data };
}

/** Intersection of two [minX,minY,maxX,maxY] boxes, or null if disjoint. Pure. */
function intersectBbox(a, b) {
  const box = [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];
  return box[0] < box[2] && box[1] < box[3] ? box : null;
}

/** Fraction of box `aoi`'s area covered by box `scene`. Pure. */
function coverageFraction(aoi, scene) {
  const i = intersectBbox(aoi, scene);
  if (!i) return 0;
  const area = (b) => (b[2] - b[0]) * (b[3] - b[1]);
  return area(i) / area(aoi);
}

/** Pixel dimensions for a bbox at ~TARGET_M_PER_PX, capped at MAX_DIM. Pure. */
function cropSize(bbox) {
  const midLat = (bbox[1] + bbox[3]) / 2;
  const mPerDegLon = 111320 * Math.cos((midLat * Math.PI) / 180);
  const w = Math.min(MAX_DIM, Math.max(64, Math.round(((bbox[2] - bbox[0]) * mPerDegLon) / TARGET_M_PER_PX)));
  const h = Math.min(MAX_DIM, Math.max(64, Math.round(((bbox[3] - bbox[1]) * 111320) / TARGET_M_PER_PX)));
  return { w, h };
}

/**
 * Count bright radar targets in a VV amplitude crop. Threshold = k × sea-clutter median (ships
 * verified >5× median vs p99.9 <2× — the gap is wide, k=5 is conservative both ways), then
 * 8-connected components with >= minPx pixels (single-pixel speckle spikes rejected).
 * Returns { count, targets, medianAmp, validPx }. Pure.
 */
function detectTargets(vv, mask, w, h, { k = 5, minPx = 2 } = {}) {
  const valid = [];
  for (let i = 0; i < w * h; i++) if (mask[i]) valid.push(vv[i]);
  if (valid.length === 0) return { count: 0, targets: [], medianAmp: 0, validPx: 0 };
  valid.sort((a, b) => a - b);
  const medianAmp = valid[valid.length >> 1];
  const thr = Math.max(1, medianAmp * k);
  const seen = new Uint8Array(w * h);
  const targets = [];
  for (let i = 0; i < w * h; i++) {
    if (seen[i] || !mask[i] || vv[i] < thr) continue;
    let size = 0, peak = 0, sx = 0, sy = 0;
    const stack = [i];
    seen[i] = 1;
    while (stack.length) {
      const j = stack.pop();
      const x = j % w, y = (j / w) | 0;
      size++; sx += x; sy += y;
      if (vv[j] > peak) peak = vv[j];
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const n = ny * w + nx;
        if (!seen[n] && mask[n] && vv[n] >= thr) { seen[n] = 1; stack.push(n); }
      }
    }
    if (size >= minPx) targets.push({ x: Math.round(sx / size), y: Math.round(sy / size), sizePx: size, peak });
  }
  targets.sort((a, b) => b.peak - a.peak);
  return { count: targets.length, targets, medianAmp, validPx: valid.length };
}

/** Convert a target's pixel centroid back to lon/lat within the fetched bbox. Pure. */
function targetLonLat(target, bbox, w, h) {
  return {
    lon: +(bbox[0] + ((target.x + 0.5) / w) * (bbox[2] - bbox[0])).toFixed(4),
    lat: +(bbox[3] - ((target.y + 0.5) / h) * (bbox[3] - bbox[1])).toFixed(4),
  };
}

async function searchScenes(bbox, days, fetchImpl = fetch) {
  const since = new Date(Date.now() - days * 86400e3).toISOString();
  const res = await fetchImpl(STAC_SEARCH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      collections: [COLLECTION],
      bbox,
      datetime: `${since}/..`,
      limit: 200,
      sortby: [{ field: 'datetime', direction: 'desc' }],
    }),
  });
  if (!res.ok) throw new Error(`STAC search ${res.status}`);
  const json = await res.json();
  return (json.features || []).map((f) => ({ id: f.id, datetime: f.properties?.datetime, bbox: f.bbox }));
}

async function fetchCrop(itemId, bbox, fetchImpl = fetch) {
  const { w, h } = cropSize(bbox);
  const url = `${DATA_API_BASE}/${bbox.join(',')}/${w}x${h}.npy?collection=${COLLECTION}&item=${itemId}&assets=vv`;
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`crop fetch ${res.status} for ${itemId}`);
  const { shape, data } = parseNpy(Buffer.from(await res.arrayBuffer()));
  if (shape.length !== 3 || shape[0] < 2 || shape[1] !== h || shape[2] !== w) {
    throw new Error(`unexpected npy shape ${shape.join('x')} (wanted 2x${h}x${w})`);
  }
  return { vv: data.subarray(0, w * h), mask: data.subarray(w * h, 2 * w * h), w, h };
}

/** Full sweep of one AOI: every scene in range → coverage + target count. Network. */
async function sweepAoi(aoi, days, fetchImpl = fetch) {
  const scenes = await searchScenes(aoi.bbox, days, fetchImpl);
  const rows = [];
  for (const scene of scenes) {
    const coverage = coverageFraction(aoi.bbox, scene.bbox);
    if (coverage < 0.3) continue; // grazing swath edge — too little water to say anything
    const box = intersectBbox(aoi.bbox, scene.bbox);
    try {
      const { vv, mask, w, h } = await fetchCrop(scene.id, box, fetchImpl);
      const det = detectTargets(vv, mask, w, h);
      rows.push({
        aoi: aoi.id,
        scene: scene.id,
        datetime: scene.datetime,
        coverage: +coverage.toFixed(2),
        targets: det.count,
        medianAmp: det.medianAmp,
        positions: det.targets.slice(0, 20).map((t) => ({ ...targetLonLat(t, box, w, h), sizePx: t.sizePx, peak: t.peak })),
      });
    } catch (e) {
      rows.push({ aoi: aoi.id, scene: scene.id, datetime: scene.datetime, coverage: +coverage.toFixed(2), error: String(e.message || e) });
    }
  }
  return rows;
}

/**
 * Merge sweep rows into an existing JSONL log: rows whose (aoi, scene) pair is already logged
 * are dropped, error rows never enter the log, and fresh rows come back oldest-first so the
 * file stays chronological under append. Malformed existing lines are tolerated (the log is
 * append-only forever; one bad line must not wedge the sweep). Returns JSONL strings. Pure.
 */
function mergeLogLines(existingLines, rows) {
  const seen = new Set();
  for (const line of existingLines) {
    if (!line || !line.trim()) continue;
    try { const r = JSON.parse(line); if (r.aoi && r.scene) seen.add(`${r.aoi}|${r.scene}`); } catch { /* tolerated */ }
  }
  return rows
    .filter((r) => !r.error && !seen.has(`${r.aoi}|${r.scene}`))
    .sort((a, b) => (a.datetime < b.datetime ? -1 : 1))
    .map(({ aoi, scene, datetime, coverage, targets, medianAmp }) =>
      JSON.stringify({ aoi, scene, datetime, coverage, targets, medianAmp }));
}

module.exports = {
  AOIS, parseNpy, intersectBbox, coverageFraction, cropSize, detectTargets, targetLonLat,
  searchScenes, fetchCrop, sweepAoi, mergeLogLines,
};

if (require.main === module) {
  (async () => {
    const args = process.argv.slice(2);
    const days = Number(args[args.indexOf('--days') + 1]) || 45;
    const asJson = args.includes('--json');
    const appendPath = args.includes('--append') ? args[args.indexOf('--append') + 1] : null;
    const aoiArg = args.find((a) => !a.startsWith('--') && a !== String(days) && a !== appendPath);
    const aois = aoiArg ? AOIS.filter((a) => a.id === aoiArg) : AOIS;
    if (aois.length === 0) {
      console.error(`unknown AOI "${aoiArg}" — known: ${AOIS.map((a) => a.id).join(', ')}`);
      process.exit(1);
    }
    const all = [];
    for (const aoi of aois) {
      const rows = await sweepAoi(aoi, days);
      all.push(...rows);
      if (!asJson) {
        console.log(`\n${aoi.name} — last ${days}d, ${rows.length} usable scenes`);
        for (const r of rows) {
          console.log(r.error
            ? `  ${r.datetime}  cov ${(r.coverage * 100).toFixed(0).padStart(3)}%  ERROR ${r.error}`
            : `  ${r.datetime}  cov ${(r.coverage * 100).toFixed(0).padStart(3)}%  targets ${String(r.targets).padStart(3)}  (sea median ${r.medianAmp})`);
        }
        const full = rows.filter((r) => !r.error && r.coverage >= 0.9).map((r) => r.targets);
        if (full.length) {
          const sorted = [...full].sort((a, b) => a - b);
          console.log(`  → full-coverage scenes: ${full.length}, median targets ${sorted[sorted.length >> 1]}, latest ${full[0]}`);
        }
      }
    }
    if (asJson) console.log(JSON.stringify(all, null, 2));
    if (appendPath) {
      const fs = require('fs');
      const raw = fs.existsSync(appendPath) ? fs.readFileSync(appendPath, 'utf8') : '';
      const fresh = mergeLogLines(raw.split('\n'), all);
      // A last record without its trailing newline must not swallow the first fresh one — the
      // glued line would parse as neither, drop out of `seen`, and re-append forever.
      const sep = raw && !raw.endsWith('\n') ? '\n' : '';
      if (fresh.length) fs.appendFileSync(appendPath, sep + fresh.join('\n') + '\n');
      console.log(`\nappended ${fresh.length} new scene(s) to ${appendPath}`);
    }
  })().catch((e) => { console.error(e); process.exit(1); });
}
