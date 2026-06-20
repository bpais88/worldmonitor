'use strict';

const { test } = require('node:test');
const { strict: assert } = require('node:assert');

const { interpretMarineWeather } = require('./explainer-weather.cjs');

test('flags rough seas at high wave height (high confidence)', () => {
  const r = interpretMarineWeather({ waveHeightM: 2.8 });
  assert.ok(r);
  assert.equal(r.source, 'weather');
  assert.equal(r.kind, 'rough_seas');
  assert.ok(r.confidence >= 0.8);
  assert.match(r.summary, /2\.8/); // includes the actual wave height
});

test('returns null for calm/slight seas', () => {
  assert.equal(interpretMarineWeather({ waveHeightM: 0.4 }), null);
});

test('flags choppy seas at moderate wave height (lower confidence)', () => {
  const r = interpretMarineWeather({ waveHeightM: 1.6 });
  assert.ok(r);
  assert.equal(r.kind, 'rough_seas');
  assert.ok(r.confidence > 0 && r.confidence < 0.8);
});

test('flags strong wind even when waves are modest', () => {
  const r = interpretMarineWeather({ waveHeightM: 0.6, windKts: 36 });
  assert.ok(r);
  assert.ok(r.confidence >= 0.8);
  assert.match(r.summary, /wind/i);
});

test('returns null when no usable data', () => {
  assert.equal(interpretMarineWeather({}), null);
  assert.equal(interpretMarineWeather(null), null);
});
