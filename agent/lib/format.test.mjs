import { test } from 'node:test';
import assert from 'node:assert/strict';

import { formatPing, formatResolution, formatDigest } from './format.mjs';

function inc(over = {}) {
  return {
    mmsi: '247000001', name: 'CAREMAR DRIADE', destName: 'Capri', region: 'Campania',
    stalled: false, etaGrowthMin: 35,
    reasons: [{ source: 'meteoalarm', kind: 'marine_warning', summary: 'official orange coastal warning for Campania', confidence: 0.7 }],
    ...over,
  };
}

test('formatPing includes vessel, destination, delay and the top reason', () => {
  const s = formatPing({ incident: inc(), kind: 'new' });
  assert.match(s, /CAREMAR DRIADE/);
  assert.match(s, /Capri/);
  assert.match(s, /35m/);
  assert.match(s, /coastal warning/i);
});

test('formatPing includes the ETA when available', () => {
  const s = formatPing({ incident: inc({ etaText: '1h 10m' }), kind: 'new' });
  assert.match(s, /ETA 1h 10m/);
});

test('formatPing includes a dashboard link when given', () => {
  const s = formatPing({ incident: inc() }, { dashboardUrl: 'https://example.app/ferry.html' });
  assert.match(s, /https:\/\/example\.app\/ferry\.html/);
});

test('formatPing marks an escalation', () => {
  const s = formatPing({ incident: inc(), kind: 'escalated' });
  assert.match(s, /escalat/i);
});

test('formatPing handles a stalled vessel with no reasons', () => {
  const s = formatPing({ incident: inc({ stalled: true, reasons: [], etaGrowthMin: 0 }), kind: 'new' });
  assert.match(s, /stalled/i);
  assert.match(s, /CAREMAR DRIADE/);
});

test('formatResolution names the cleared vessel', () => {
  assert.match(formatResolution('CAREMAR DRIADE'), /CAREMAR DRIADE/);
  assert.match(formatResolution('CAREMAR DRIADE'), /clear|resolv|back/i);
});

test('formatDigest summarises counts', () => {
  const s = formatDigest([inc(), inc({ mmsi: '2', region: 'Sicilia', stalled: true })]);
  assert.match(s, /2/);          // total
  assert.match(s, /Campania|Sicilia/);
});
