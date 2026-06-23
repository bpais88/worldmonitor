'use strict';

const { test } = require('node:test');
const { strict: assert } = require('node:assert');
const { relayFreshness } = require('./freshness.cjs');

const T = 1_700_000_000_000;

test('warming until a full tile sweep has completed', () => {
  // 9-tile grid, only 4 polled so far → still warming.
  assert.equal(relayFreshness({ lastPollAt: T, pollsOk: 4, tileCount: 9, now: T }).warming, true);
  // All 9 (or more) polled → warmed up.
  assert.equal(relayFreshness({ lastPollAt: T, pollsOk: 9, tileCount: 9, now: T }).warming, false);
  assert.equal(relayFreshness({ lastPollAt: T, pollsOk: 30, tileCount: 9, now: T }).warming, false);
});

test('never reports warmed-up when no tiles configured', () => {
  assert.equal(relayFreshness({ lastPollAt: T, pollsOk: 0, tileCount: 0, now: T }).warming, true);
});

test('stale when the last poll is older than the threshold', () => {
  assert.equal(relayFreshness({ lastPollAt: T, pollsOk: 9, tileCount: 9, now: T + 30_000 }).stale, false);
  assert.equal(relayFreshness({ lastPollAt: T, pollsOk: 9, tileCount: 9, now: T + 5 * 60_000 }).stale, true);
});

test('stale immediately when there has been no successful poll', () => {
  const f = relayFreshness({ lastPollAt: null, pollsOk: 0, tileCount: 9, now: T });
  assert.equal(f.stale, true);
  assert.equal(f.ageSec, null);
});

test('ageSec is the seconds since the last poll (never negative)', () => {
  assert.equal(relayFreshness({ lastPollAt: T, pollsOk: 9, tileCount: 9, now: T + 42_000 }).ageSec, 42);
  assert.equal(relayFreshness({ lastPollAt: T + 5_000, pollsOk: 9, tileCount: 9, now: T }).ageSec, 0); // clock skew → clamp
});
