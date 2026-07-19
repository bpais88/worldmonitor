'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const {
  AOIS, parseNpy, intersectBbox, coverageFraction, cropSize, detectTargets, targetLonLat,
  mergeLogLines,
} = require('./sar-occupancy.cjs');

// --- parseNpy ------------------------------------------------------------------------------

/** Build a v1 .npy buffer the way numpy writes it: magic, header dict, LE uint16 payload. */
function npyBuffer(shape, values) {
  let header = `{'descr': '<u2', 'fortran_order': False, 'shape': (${shape.join(', ')}), }`;
  const pad = 64 - ((10 + header.length + 1) % 64);
  header += ' '.repeat(pad) + '\n';
  const buf = Buffer.alloc(10 + header.length + values.length * 2);
  buf[0] = 0x93;
  buf.write('NUMPY', 1, 'latin1');
  buf[6] = 1; buf[7] = 0;
  buf.writeUInt16LE(header.length, 8);
  buf.write(header, 10, 'latin1');
  values.forEach((v, i) => buf.writeUInt16LE(v, 10 + header.length + i * 2));
  return buf;
}

test('parseNpy reads shape and LE uint16 data', () => {
  const { shape, data } = parseNpy(npyBuffer([2, 2, 3], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]));
  assert.deepStrictEqual(shape, [2, 2, 3]);
  assert.strictEqual(data.length, 12);
  assert.strictEqual(data[0], 1);
  assert.strictEqual(data[11], 12);
});

test('parseNpy rejects non-npy and wrong dtype', () => {
  assert.throws(() => parseNpy(Buffer.from('not an npy at all')), /not an \.npy/);
  const f4 = npyBuffer([1, 1, 1], [0]);
  f4.write("{'descr': '<f4'", 10, 'latin1'); // corrupt dtype in place
  assert.throws(() => parseNpy(f4), /dtype/);
});

test('parseNpy rejects a buffer shorter than its declared shape', () => {
  const buf = npyBuffer([2, 4, 4], new Array(32).fill(0)).subarray(0, 40);
  assert.throws(() => parseNpy(buf), /shorter/);
});

// --- geometry ------------------------------------------------------------------------------

test('intersectBbox: overlap, containment, disjoint', () => {
  assert.deepStrictEqual(intersectBbox([0, 0, 2, 2], [1, 1, 3, 3]), [1, 1, 2, 2]);
  assert.deepStrictEqual(intersectBbox([0, 0, 4, 4], [1, 1, 2, 2]), [1, 1, 2, 2]);
  assert.strictEqual(intersectBbox([0, 0, 1, 1], [2, 2, 3, 3]), null);
});

test('coverageFraction: full, half, none', () => {
  assert.strictEqual(coverageFraction([0, 0, 2, 2], [-1, -1, 3, 3]), 1);
  assert.strictEqual(coverageFraction([0, 0, 2, 2], [1, 0, 3, 2]), 0.5);
  assert.strictEqual(coverageFraction([0, 0, 2, 2], [5, 5, 6, 6]), 0);
});

test('cropSize targets ~50 m/px and stays within caps', () => {
  const { w, h } = cropSize([54.70, 25.05, 54.92, 25.33]); // Jebel Ali AOI, ~22x31 km
  assert.ok(w >= 350 && w <= 500, `w=${w}`);
  assert.ok(h >= 550 && h <= 700, `h=${h}`);
  const huge = cropSize([0, 0, 10, 10]);
  assert.strictEqual(huge.w, 1024);
  assert.strictEqual(huge.h, 1024);
});

// --- detection -----------------------------------------------------------------------------

/** Synthetic sea: uniform clutter at 100, optional bright blobs painted on. */
function sea(w, h, blobs = []) {
  const vv = new Uint16Array(w * h).fill(100);
  const mask = new Uint16Array(w * h).fill(255);
  for (const { x, y, size = 2, amp = 2000 } of blobs) {
    for (let i = 0; i < size; i++) vv[y * w + x + i] = amp; // horizontal streak of `size` px
  }
  return { vv, mask };
}

test('detectTargets: clean sea has zero targets', () => {
  const { vv, mask } = sea(64, 64);
  const det = detectTargets(vv, mask, 64, 64);
  assert.strictEqual(det.count, 0);
  assert.strictEqual(det.medianAmp, 100);
});

test('detectTargets: two separated ships found, single-pixel speckle rejected', () => {
  const { vv, mask } = sea(64, 64, [
    { x: 10, y: 10, size: 4, amp: 3000 },
    { x: 40, y: 50, size: 3, amp: 900 },
    { x: 55, y: 5, size: 1, amp: 5000 }, // 1-px speckle spike — below minPx
  ]);
  const det = detectTargets(vv, mask, 64, 64);
  assert.strictEqual(det.count, 2);
  assert.strictEqual(det.targets[0].peak, 3000); // sorted brightest first
  assert.strictEqual(det.targets[0].sizePx, 4);
});

test('detectTargets: diagonal-adjacent pixels merge into one target (8-connectivity)', () => {
  const { vv, mask } = sea(32, 32);
  vv[10 * 32 + 10] = 2000;
  vv[11 * 32 + 11] = 2000; // diagonal neighbor
  const det = detectTargets(vv, mask, 32, 32);
  assert.strictEqual(det.count, 1);
  assert.strictEqual(det.targets[0].sizePx, 2);
});

test('detectTargets: masked (nodata) pixels are ignored entirely', () => {
  const { vv, mask } = sea(32, 32, [{ x: 5, y: 5, size: 3, amp: 4000 }]);
  for (let i = 0; i < 32 * 32; i++) if (i % 32 < 16) mask[i] = 0; // left half nodata
  const det = detectTargets(vv, mask, 32, 32);
  assert.strictEqual(det.count, 0); // ship sat in the masked half
  assert.strictEqual(det.validPx, 32 * 16);
});

test('targetLonLat maps pixel centroid back into the bbox', () => {
  const { lon, lat } = targetLonLat({ x: 0, y: 0 }, [10, 20, 11, 21], 10, 10);
  assert.ok(Math.abs(lon - 10.05) < 1e-9, `lon=${lon}`);
  assert.ok(Math.abs(lat - 20.95) < 1e-9, `lat=${lat}`);
});

// --- log merge ----------------------------------------------------------------------------

const row = (aoi, scene, datetime, targets = 3) =>
  ({ aoi, scene, datetime, coverage: 1, targets, medianAmp: 80, positions: [] });

test('mergeLogLines: dedupes on (aoi, scene), keeps new rows chronological', () => {
  const existing = [JSON.stringify({ aoi: 'a', scene: 's1', datetime: '2026-07-01T00:00:00Z', coverage: 1, targets: 2, medianAmp: 60 })];
  const out = mergeLogLines(existing, [
    row('a', 's3', '2026-07-09T00:00:00Z'),
    row('a', 's1', '2026-07-01T00:00:00Z'), // already logged
    row('a', 's2', '2026-07-05T00:00:00Z'),
  ]);
  assert.strictEqual(out.length, 2);
  assert.strictEqual(JSON.parse(out[0]).scene, 's2'); // oldest first
  assert.strictEqual(JSON.parse(out[1]).scene, 's3');
});

test('mergeLogLines: same scene id under two AOIs is two log rows', () => {
  const existing = [JSON.stringify({ aoi: 'a', scene: 's1', datetime: '2026-07-01T00:00:00Z' })];
  const out = mergeLogLines(existing, [row('b', 's1', '2026-07-01T00:00:00Z')]);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(JSON.parse(out[0]).aoi, 'b');
});

test('mergeLogLines: error rows and position payloads never reach the log', () => {
  const out = mergeLogLines([], [
    { aoi: 'a', scene: 'bad', datetime: '2026-07-02T00:00:00Z', coverage: 0.9, error: 'crop fetch 500' },
    row('a', 'ok', '2026-07-03T00:00:00Z'),
  ]);
  assert.strictEqual(out.length, 1);
  const logged = JSON.parse(out[0]);
  assert.strictEqual(logged.scene, 'ok');
  assert.strictEqual('positions' in logged, false);
  assert.strictEqual('error' in logged, false);
});

test('mergeLogLines: malformed and blank existing lines are tolerated', () => {
  const existing = ['', '   ', 'not json at all', JSON.stringify({ aoi: 'a', scene: 's1' })];
  const out = mergeLogLines(existing, [row('a', 's1', '2026-07-01T00:00:00Z'), row('a', 's2', '2026-07-02T00:00:00Z')]);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(JSON.parse(out[0]).scene, 's2');
});

test('shipped AOIs stay water-only shaped: nonzero area, sane Gulf coordinates', () => {
  for (const aoi of AOIS) {
    const [minX, minY, maxX, maxY] = aoi.bbox;
    assert.ok(minX < maxX && minY < maxY, aoi.id);
    assert.ok(minX > 50 && maxX < 60 && minY > 24 && maxY < 28, `${aoi.id} out of Gulf bounds`);
  }
});
