import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classifyIncidents, isSignificant } from './episodes.mjs';

const NOW = 1_700_000_000_000;

// A flagged incident as produced from the relay's delay + reasons.
function inc(over = {}) {
  return {
    mmsi: '247000001',
    name: 'CAREMAR DRIADE',
    destName: 'Capri',
    region: 'Campania',
    stalled: false,
    etaGrowthMin: 35,
    reasons: [{ source: 'meteoalarm', kind: 'marine_warning', summary: 'orange coastal warning', confidence: 0.7 }],
    ...over,
  };
}

test('isSignificant: high-confidence reason / stalled / big ETA growth', () => {
  assert.equal(isSignificant(inc()), true);                                   // 0.7 reason
  assert.equal(isSignificant(inc({ reasons: [], etaGrowthMin: 40 })), true);  // big growth
  assert.equal(isSignificant(inc({ reasons: [], etaGrowthMin: 5, stalled: true })), true);
  assert.equal(isSignificant(inc({ reasons: [{ source: 'news', kind: 'strike', summary: 'x', confidence: 0.4 }], etaGrowthMin: 8, stalled: false })), false);
});

test('a new significant incident produces a "new" ping and is remembered', () => {
  const { pings, resolutions, nextMem } = classifyIncidents([inc()], new Map(), NOW);
  assert.equal(pings.length, 1);
  assert.equal(pings[0].kind, 'new');
  assert.equal(pings[0].incident.mmsi, '247000001');
  assert.equal(resolutions.length, 0);
  assert.ok(nextMem.has('247000001'));
});

test('the same ongoing incident is NOT re-pinged next tick (dedup)', () => {
  const first = classifyIncidents([inc()], new Map(), NOW);
  const second = classifyIncidents([inc()], first.nextMem, NOW + 600_000);
  assert.equal(second.pings.length, 0);
});

test('escalation re-pings: a new reason kind appears', () => {
  const first = classifyIncidents([inc()], new Map(), NOW);
  const escalated = inc({ reasons: [
    { source: 'meteoalarm', kind: 'marine_warning', summary: 'orange', confidence: 0.7 },
    { source: 'fleet', kind: 'systemic_delay', summary: '3 nearby also delayed', confidence: 0.6 },
  ] });
  const second = classifyIncidents([escalated], first.nextMem, NOW + 600_000);
  assert.equal(second.pings.length, 1);
  assert.equal(second.pings[0].kind, 'escalated');
});

test('escalation re-pings: severity band rises (becomes stalled)', () => {
  const start = inc({ stalled: false, reasons: [{ source: 'weather', kind: 'rough_seas', summary: 'choppy', confidence: 0.55 }], etaGrowthMin: 32 });
  const first = classifyIncidents([start], new Map(), NOW); // band 1
  const worse = inc({ ...start, stalled: true });           // band 2
  const second = classifyIncidents([worse], first.nextMem, NOW + 600_000);
  assert.equal(second.pings.length, 1);
  assert.equal(second.pings[0].kind, 'escalated');
});

test('non-significant flagged vessels are tracked but never pinged', () => {
  const minor = inc({ stalled: false, etaGrowthMin: 8, reasons: [{ source: 'news', kind: 'strike', summary: 'x', confidence: 0.4 }] });
  const { pings, nextMem } = classifyIncidents([minor], new Map(), NOW);
  assert.equal(pings.length, 0);
  assert.ok(nextMem.has(minor.mmsi)); // tracked (for digest / future escalation)
});

test('a vessel that was flagged but is gone now resolves and drops from memory', () => {
  const first = classifyIncidents([inc()], new Map(), NOW);
  const second = classifyIncidents([], first.nextMem, NOW + 600_000);
  assert.deepEqual(second.resolutions, [{ mmsi: '247000001', name: 'CAREMAR DRIADE' }]);
  assert.equal(second.nextMem.has('247000001'), false);
});
