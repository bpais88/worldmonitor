'use strict';

const { test } = require('node:test');
const { strict: assert } = require('node:assert');
const { relayFreshness, tileFreshness, DEFAULT_STALE_MS } = require('./freshness.cjs');

const T = 1_700_000_000_000;

test('warming until a full tile sweep has completed', () => {
  // 9-tile grid, only 4 polled so far → still warming.
  assert.equal(relayFreshness({ lastPollAt: T, tilesSeen: 4, tileCount: 9, now: T }).warming, true);
  // All 9 (or more) polled → warmed up.
  assert.equal(relayFreshness({ lastPollAt: T, tilesSeen: 9, tileCount: 9, now: T }).warming, false);
  assert.equal(relayFreshness({ lastPollAt: T, tilesSeen: 30, tileCount: 9, now: T }).warming, false);
});

test('never reports warmed-up when no tiles configured', () => {
  assert.equal(relayFreshness({ lastPollAt: T, tilesSeen: 0, tileCount: 0, now: T }).warming, true);
});

test('stale when the last poll is older than the threshold', () => {
  assert.equal(relayFreshness({ lastPollAt: T, tilesSeen: 9, tileCount: 9, now: T + 30_000 }).stale, false);
  assert.equal(relayFreshness({ lastPollAt: T, tilesSeen: 9, tileCount: 9, now: T + 5 * 60_000 }).stale, true);
});

test('stale immediately when there has been no successful poll', () => {
  const f = relayFreshness({ lastPollAt: null, tilesSeen: 0, tileCount: 9, now: T });
  assert.equal(f.stale, true);
  assert.equal(f.ageSec, null);
});

test('ageSec is the seconds since the last poll (never negative)', () => {
  assert.equal(relayFreshness({ lastPollAt: T, tilesSeen: 9, tileCount: 9, now: T + 42_000 }).ageSec, 42);
  assert.equal(relayFreshness({ lastPollAt: T + 5_000, tilesSeen: 9, tileCount: 9, now: T }).ageSec, 0); // clock skew → clamp
});

test('tileFreshness: fresh within the stale window, stale beyond it', () => {
  assert.equal(tileFreshness({ lastOkAt: T, now: T + 30_000 }), true);
  assert.equal(tileFreshness({ lastOkAt: T, now: T + DEFAULT_STALE_MS }), true);      // inclusive edge
  assert.equal(tileFreshness({ lastOkAt: T, now: T + DEFAULT_STALE_MS + 1 }), false);
});

test('tileFreshness: never-polled tile is not fresh', () => {
  assert.equal(tileFreshness({ lastOkAt: undefined, now: T }), false);
  assert.equal(tileFreshness({ lastOkAt: null, now: T }), false);
});
