'use strict';

const { test } = require('node:test');
const { strict: assert } = require('node:assert');

const { matchNewsToDelay } = require('./explainer-news.cjs');

const NOW = 1_700_000_000_000;
const recent = (title) => ({ title, link: 'https://x/' + encodeURIComponent(title), pubMs: NOW - 3 * 3_600_000 });

test('matches a recent strike headline mentioning the operator', () => {
  const items = [recent('Caremar ferries hit by 24-hour strike in Naples')];
  const r = matchNewsToDelay(items, { operatorName: 'Caremar', portName: 'Naples' }, NOW);
  assert.ok(r);
  assert.equal(r.source, 'news');
  assert.equal(r.kind, 'strike');
  assert.match(r.summary, /strike/i);
  assert.ok(r.url);
  assert.ok(r.confidence > 0 && r.confidence < 0.6); // best-effort, never high
});

test('matches a disruption headline mentioning the port', () => {
  const items = [recent('Bad weather forces cancellations at Naples port')];
  const r = matchNewsToDelay(items, { operatorName: '', portName: 'Naples' }, NOW);
  assert.ok(r);
  assert.equal(r.kind, 'disruption');
});

test('ignores headlines with no operator/port mention (avoids noise)', () => {
  const items = [recent('Nationwide transport strike announced')];
  assert.equal(matchNewsToDelay(items, { operatorName: 'Caremar', portName: 'Naples' }, NOW), null);
});

test('ignores an operator mention with no disruption keyword', () => {
  const items = [recent('Caremar adds new summer route to Capri')];
  assert.equal(matchNewsToDelay(items, { operatorName: 'Caremar', portName: 'Capri' }, NOW), null);
});

test('ignores stale headlines outside the window', () => {
  const old = { title: 'Caremar strike in Naples', link: 'https://x', pubMs: NOW - 5 * 24 * 3_600_000 };
  assert.equal(matchNewsToDelay([old], { operatorName: 'Caremar', portName: 'Naples' }, NOW), null);
});

test('returns null with no operator and no port (cannot attribute)', () => {
  const items = [recent('Ferry strike somewhere')];
  assert.equal(matchNewsToDelay(items, { operatorName: '', portName: '' }, NOW), null);
});
