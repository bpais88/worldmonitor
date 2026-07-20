import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseDisruptions, bucketOf, type DisruptionKind } from '../src/services/logistics/disruptions.ts';

// A response shaped like the live /ais/disruptions feed (strikes + water + chokepoint).
const feed = () => ({
  events: [
    { id: 'http://scioperi.mit.gov.it/8448', kind: 'strike_scheduled', summary: 'Scheduled Marittimo strike (national)', source: 'mit-scioperi', confidence: 0.9, startsAt: 1_800_000_000_000, country: 'IT' },
    { id: 'water:kaub:low', kind: 'waterway_low_water', summary: 'Rhine at Kaub 80 cm below surcharge mark', source: 'pegelonline', confidence: 0.9, startsAt: null, country: null },
    { id: 'acp:ADV-22-2026', kind: 'draft_restriction', summary: 'Panama Canal draft adjustment', source: 'acp-advisories', confidence: 0.9, startsAt: null, country: null, url: 'https://pancanal.com/x.pdf' },
    { id: 'market:hormuz:severe', kind: 'chokepoint_disruption', summary: 'Market-implied: Hormuz flow severely disrupted', source: 'market-implied', confidence: 0.7, startsAt: null, country: null },
    { id: 'gdelt:foo', kind: 'strike_report', summary: 'Reported port unrest', source: 'gdelt', confidence: 0.3, startsAt: null, country: 'ES' },
  ],
});

describe('parseDisruptions', () => {
  it('maps the live feed shape to typed events', () => {
    const out = parseDisruptions(feed());
    assert.equal(out.length, 5);
    const strike = out.find((e) => e.kind === 'strike_scheduled')!;
    assert.equal(strike.startsAt, 1_800_000_000_000);
    assert.equal(strike.country, 'IT');
    const draft = out.find((e) => e.kind === 'draft_restriction')!;
    assert.equal(draft.url, 'https://pancanal.com/x.pdf');
  });

  it('drops rows missing id/summary or with an unknown kind', () => {
    const out = parseDisruptions({ events: [
      { id: 'ok', kind: 'waterway_low_water', summary: 'valid', source: 'pegelonline', confidence: 0.9 },
      { id: 'no-summary', kind: 'strike_scheduled', source: 'x', confidence: 0.9 },
      { kind: 'water_closure', summary: 'no id', source: 'x', confidence: 0.9 },
      { id: 'weird', kind: 'volcano', summary: 'unknown kind', source: 'x', confidence: 0.9 },
    ] });
    assert.equal(out.length, 1);
    assert.equal(out[0].id, 'ok');
  });

  it('defaults startsAt/url/country to null and non-numeric startsAt to null', () => {
    const [e] = parseDisruptions({ events: [
      { id: 'a', kind: 'chokepoint_disruption', summary: 's', source: 'market-implied', confidence: 0.6, startsAt: 'soon' },
    ] });
    assert.equal(e.startsAt, null);
    assert.equal(e.url, null);
    assert.equal(e.country, null);
  });

  it('returns [] for a malformed payload', () => {
    assert.deepEqual(parseDisruptions({}), []);
    assert.deepEqual(parseDisruptions(null), []);
    assert.deepEqual(parseDisruptions({ events: 'nope' }), []);
  });
});

describe('bucketOf', () => {
  it('routes each kind to its display bucket', () => {
    const cases: [DisruptionKind, string][] = [
      ['strike_scheduled', 'official'],
      ['water_closure', 'official'],
      ['draft_restriction', 'official'],
      ['waterway_low_water', 'signals'],
      ['chokepoint_disruption', 'signals'],
      ['strike_report', 'reports'],
    ];
    for (const [kind, bucket] of cases) assert.equal(bucketOf(kind), bucket, kind);
  });
});
