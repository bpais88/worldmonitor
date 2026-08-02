'use strict';

const { test } = require('node:test');
const { strict: assert } = require('node:assert');

const { resamplePortRows, PORT_SERIES_MAX_CARRY_MIN } = require('./db.cjs');

const MIN = 60_000;
const STEP = 15 * MIN;
const T0 = 1_700_000_000_000;

/** A raw snapshot row as the query returns it (ts in ms, snake_case columns). */
const row = (port_id, tsOffsetMin, at_berth, at_port = at_berth * 2) => ({
  ts: T0 + tsOffsetMin * MIN, port_id, at_berth, at_port,
});

const resample = (rows, opts = {}) => resamplePortRows(rows, {
  startTs: T0, endTs: T0 + 60 * MIN, stepMs: STEP, fields: ['atBerth'], ...opts,
});

test('builds a regular grid inclusive of both ends', () => {
  const { ts } = resample([]);
  assert.deepEqual(ts, [T0, T0 + 15 * MIN, T0 + 30 * MIN, T0 + 45 * MIN, T0 + 60 * MIN]);
});

test('places a reading at the frame it falls on', () => {
  const { ports } = resample([row('rotterdam', 0, 7)]);
  assert.equal(ports.rotterdam.atBerth[0], 7);
});

test('carries the last reading forward across frames with no new data', () => {
  // One reading at t=0, nothing after. Within the carry window the value holds, then goes null.
  const { ports } = resample([row('rotterdam', 0, 7)]);
  const s = ports.rotterdam.atBerth;
  assert.equal(s[0], 7, 'frame 0 has the reading');
  assert.equal(s[1], 7, '+15min is within the 30min carry');
  assert.equal(s[2], 7, '+30min is exactly at the carry bound');
  assert.equal(s[3], null, '+45min exceeds the carry — unknown, not stale data');
  assert.equal(s[4], null);
});

test('the carry bound is the documented constant, not an accident', () => {
  assert.equal(PORT_SERIES_MAX_CARRY_MIN, 30);
  const { ports } = resample([row('p', 0, 1)], { maxCarryMs: 10 * MIN });
  assert.equal(ports.p.atBerth[0], 1);
  assert.equal(ports.p.atBerth[1], null, 'a 10min carry cannot reach the +15min frame');
});

test('a later reading supersedes the carried one', () => {
  const { ports } = resample([row('rotterdam', 0, 7), row('rotterdam', 20, 12)]);
  const s = ports.rotterdam.atBerth;
  assert.equal(s[0], 7);
  assert.equal(s[1], 7, 'the t=20 reading is after the +15min frame');
  assert.equal(s[2], 12, 'the +30min frame sees it');
});

test('takes the MOST RECENT reading when several fall inside one frame', () => {
  const { ports } = resample([row('p', 0, 1), row('p', 5, 2), row('p', 10, 3)]);
  assert.equal(ports.p.atBerth[0], 1, 'only t=0 is at or before frame 0');
  assert.equal(ports.p.atBerth[1], 3, 'frame +15 sees the latest of 0/5/10, not the first');
});

test('frames before a port\'s first reading are null, never zero', () => {
  // The exact case the real data hit: 12 ports were purged and had no history for the first
  // stretch of the window. Rendering that as 0 would animate as "the port was empty".
  const { ports } = resample([row('rotterdam', 45, 9)]);
  const s = ports.rotterdam.atBerth;
  assert.deepEqual(s.slice(0, 3), [null, null, null], 'no data yet ≠ no ships');
  assert.equal(s[3], 9);
});

test('keeps ports independent — one port going dark does not affect another', () => {
  const { ports } = resample([row('a', 0, 5), row('b', 0, 1), row('b', 45, 2)]);
  assert.deepEqual(ports.a.atBerth, [5, 5, 5, null, null]);
  assert.deepEqual(ports.b.atBerth, [1, 1, 1, 2, 2]);
});

test('every field array is index-aligned to the ts axis', () => {
  const { ts, ports } = resample([row('a', 0, 5), row('b', 30, 2)], { fields: ['atBerth', 'atPort'] });
  for (const [id, series] of Object.entries(ports)) {
    for (const [field, arr] of Object.entries(series)) {
      assert.equal(arr.length, ts.length, `${id}.${field} must be one value per frame`);
    }
  }
});

test('carries every requested field together, not just the first', () => {
  const { ports } = resample([row('a', 0, 5, 11)], { fields: ['atBerth', 'atPort'] });
  assert.equal(ports.a.atBerth[1], 5);
  assert.equal(ports.a.atPort[1], 11);
});

test('preserves a genuine zero — an empty port is not an absent one', () => {
  const { ports } = resample([row('a', 0, 0)]);
  assert.equal(ports.a.atBerth[0], 0, '0 must survive as 0, distinct from null');
  assert.notEqual(ports.a.atBerth[0], null);
});

test('a null column value is null, not coerced to zero', () => {
  const { ports } = resample([{ ts: T0, port_id: 'a', at_berth: null }]);
  assert.equal(ports.a.atBerth[0], null);
});

test('returns no ports when there are no rows', () => {
  const { ts, ports } = resample([]);
  assert.deepEqual(ports, {});
  assert.equal(ts.length, 5, 'the grid still exists — the window is known, the data is not');
});
