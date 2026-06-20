'use strict';

const { test } = require('node:test');
const { strict: assert } = require('node:assert');

const { aggregateReasons, runExplainers } = require('./delay-explainers.cjs');

test('aggregateReasons ranks by confidence, highest first', () => {
  const reasons = [
    { source: 'news', kind: 'strike', summary: 'Possible strike', confidence: 0.4 },
    { source: 'weather', kind: 'rough_seas', summary: 'Rough seas', confidence: 0.85 },
  ];
  const out = aggregateReasons(reasons);
  assert.equal(out[0].source, 'weather');
  assert.equal(out[1].source, 'news');
});

test('aggregateReasons dedupes by source+kind, keeping the higher confidence', () => {
  const reasons = [
    { source: 'weather', kind: 'rough_seas', summary: 'Rough seas (low)', confidence: 0.6 },
    { source: 'weather', kind: 'rough_seas', summary: 'Rough seas (high)', confidence: 0.85 },
  ];
  const out = aggregateReasons(reasons);
  assert.equal(out.length, 1);
  assert.equal(out[0].confidence, 0.85);
  assert.equal(out[0].summary, 'Rough seas (high)');
});

test('aggregateReasons drops entries without a summary', () => {
  const out = aggregateReasons([{ source: 'x', kind: 'y', confidence: 0.9 }, null]);
  assert.equal(out.length, 0);
});

test('runExplainers runs the registry and survives a failing explainer', async () => {
  const good = { id: 'weather', explain: async () => [{ source: 'weather', kind: 'rough_seas', summary: 'Rough', confidence: 0.8 }] };
  const broken = { id: 'news', explain: async () => { throw new Error('boom'); } };
  const out = await runExplainers([broken, good], { mmsi: '1' });
  assert.equal(out.length, 1);
  assert.equal(out[0].source, 'weather');
});
