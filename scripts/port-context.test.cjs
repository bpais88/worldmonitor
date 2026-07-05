'use strict';

const { test } = require('node:test');
const { strict: assert } = require('node:assert');
const { craneWindReason, baselineAnomalyReason, assemblePortContext } = require('./port-context.cjs');

test('craneWindReason: quiet winds → null; slow/stop thresholds escalate', () => {
  assert.equal(craneWindReason({ windKts: 12, windGustKts: 20 }), null);
  const slow = craneWindReason({ windGustKts: 43 });
  assert.equal(slow.kind, 'crane_wind');
  assert.match(slow.summary, /near crane operating limits/);
  const stop = craneWindReason({ windGustKts: 55 });
  assert.match(stop.summary, /above typical crane-stop limits/);
  assert.ok(stop.confidence > slow.confidence);
  // Sustained-wind fallback only when the gust reading is missing.
  assert.match(craneWindReason({ windKts: 38 }).summary, /Sustained wind/);
  assert.equal(craneWindReason({ windKts: 38, windGustKts: 30 }), null);
  assert.equal(craneWindReason({}), null);
});

test('baselineAnomalyReason: silent below p90, silent on untrusted buckets, speaks with numbers above', () => {
  const bucket = { p75: 30, p90: 38, days: 5 };
  assert.equal(baselineAnomalyReason({ atBerth: 35, bucket }), null);           // busy but normal
  assert.equal(baselineAnomalyReason({ atBerth: 47, bucket: { ...bucket, days: 2 } }), null); // baseline too young
  const r = baselineAnomalyReason({ atBerth: 47, bucket });
  assert.match(r.summary, /47 vessels at berth vs a typical p90 of 38/);
  assert.equal(r.kind, 'above_normal');
  assert.equal(baselineAnomalyReason({ atBerth: 47 }), null);
});

test('assemblePortContext: drops nulls, ranks by confidence, caps', () => {
  const out = assemblePortContext([
    null,
    { source: 'news', kind: 'strike', summary: 'a', confidence: 0.45 },
    { source: 'baseline', kind: 'above_normal', summary: 'b', confidence: 0.7 },
    null,
    { source: 'weather-ops', kind: 'crane_wind', summary: 'c', confidence: 0.6 },
  ]);
  assert.deepEqual(out.map((r) => r.source), ['baseline', 'weather-ops', 'news']);
  assert.equal(assemblePortContext([]).length, 0);
});
