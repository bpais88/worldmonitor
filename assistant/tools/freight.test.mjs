import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { etaView } from './freight.mjs';

const NOW = Date.parse('2026-06-22T21:00:00Z');

test('no ETA when the vessel is stopped / at port (no etaTs)', () => {
  assert.deepEqual(etaView({ name: 'X' }, NOW), {});
  assert.deepEqual(etaView({ etaTs: null }, NOW), {});
});

test('moving vessel: live ETA + hours remaining, no trend without delta', () => {
  const r = etaView({ etaTs: Date.parse('2026-06-23T04:00:00Z') }, NOW);
  assert.equal(r.eta, '2026-06-23 04:00Z');
  assert.equal(r.etaInHours, 7);
  assert.equal('etaTrendMin' in r, false); // no trend data → field omitted, not 0
});

test('slipping later: positive signed trend with its window', () => {
  const r = etaView({ etaTs: Date.parse('2026-06-22T22:20:00Z'), etaDeltaMin: 20, etaWindowMin: 60 }, NOW);
  assert.equal(r.etaTrendMin, 20);       // + = arriving later
  assert.equal(r.etaTrendWindowMin, 60);
});

test('running ahead: negative signed trend is preserved', () => {
  const r = etaView({ etaTs: Date.parse('2026-06-22T21:50:00Z'), etaDeltaMin: -10, etaWindowMin: 45 }, NOW);
  assert.equal(r.etaTrendMin, -10);      // − = ahead of earlier estimate
  assert.equal(r.etaTrendWindowMin, 45);
});
