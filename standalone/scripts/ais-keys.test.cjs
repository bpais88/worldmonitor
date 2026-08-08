'use strict';

const { test } = require('node:test');
const { strict: assert } = require('node:assert');

const { parseAisKeys, nextKeyIndex } = require('./ais-keys.cjs');

test('parseAisKeys reads the primary key', () => {
  assert.deepEqual(parseAisKeys({ AISSTREAM_API_KEY: 'aaa' }), ['aaa']);
});

test('parseAisKeys appends a fallback key from its own var', () => {
  assert.deepEqual(
    parseAisKeys({ AISSTREAM_API_KEY: 'aaa', AISSTREAM_API_KEY_FALLBACK: 'bbb' }),
    ['aaa', 'bbb'],
  );
});

test('parseAisKeys accepts a comma-separated pool and trims whitespace', () => {
  assert.deepEqual(
    parseAisKeys({ AISSTREAM_API_KEY: 'aaa, bbb ,ccc' }),
    ['aaa', 'bbb', 'ccc'],
  );
});

test('parseAisKeys de-dupes across vars (order preserved, first wins)', () => {
  assert.deepEqual(
    parseAisKeys({ AISSTREAM_API_KEY: 'aaa,bbb', VITE_AISSTREAM_API_KEY: 'aaa', AISSTREAM_API_KEY_FALLBACK: 'bbb,ccc' }),
    ['aaa', 'bbb', 'ccc'],
  );
});

test('parseAisKeys returns an empty pool when nothing is set', () => {
  assert.deepEqual(parseAisKeys({}), []);
  assert.deepEqual(parseAisKeys({ AISSTREAM_API_KEY: '   ' }), []);
});

test('nextKeyIndex wraps around the pool', () => {
  assert.equal(nextKeyIndex(0, 2), 1);
  assert.equal(nextKeyIndex(1, 2), 0); // wrap
  assert.equal(nextKeyIndex(2, 3), 0); // wrap
});

test('nextKeyIndex is safe for empty / single-key pools', () => {
  assert.equal(nextKeyIndex(0, 0), 0);
  assert.equal(nextKeyIndex(5, 0), 0);
  assert.equal(nextKeyIndex(0, 1), 0); // single key -> stays
});
