'use strict';

const { test } = require('node:test');
const { strict: assert } = require('node:assert');

const { interpretMarineWeather, interpretVisibility } = require('./explainer-weather.cjs');

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

test('flags fog at very low visibility (high confidence)', () => {
  const r = interpretVisibility(600);
  assert.ok(r);
  assert.equal(r.source, 'weather');
  assert.equal(r.kind, 'low_visibility');
  assert.ok(r.confidence >= 0.7);
  assert.match(r.summary, /fog|visibility/i);
});

test('flags poor visibility at moderate levels (lower confidence)', () => {
  const r = interpretVisibility(1600);
  assert.ok(r && r.kind === 'low_visibility');
  assert.ok(r.confidence > 0 && r.confidence < 0.7);
});

test('returns null for clear visibility or missing data', () => {
  assert.equal(interpretVisibility(8000), null);
  assert.equal(interpretVisibility(undefined), null);
  assert.equal(interpretVisibility(null), null);
});
