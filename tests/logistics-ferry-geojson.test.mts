import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ferriesToGeoJSON } from '../src/services/logistics/ferry-geojson.ts';
import type { TrackedFerry } from '../src/services/logistics/ferry-tracker.ts';

function ferry(overrides: Partial<TrackedFerry> = {}): TrackedFerry {
  return {
    mmsi: '247000001',
    name: 'MOBY TEST',
    lat: 41.0,
    lon: 9.5,
    status: 'under_way',
    courseDeg: 120,
    speedKnots: 18,
    etaTimestamp: null,
    hoursRemaining: null,
    confidence: 0,
    routeStatus: 'unknown',
    timestamp: 0,
    ...overrides,
  };
}

describe('ferriesToGeoJSON', () => {
  it('returns a FeatureCollection with one feature per ferry', () => {
    const fc = ferriesToGeoJSON([ferry(), ferry({ mmsi: '2', name: 'GNV' })]);
    assert.equal(fc.type, 'FeatureCollection');
    assert.equal(fc.features.length, 2);
  });

  it('emits coordinates in [lon, lat] order', () => {
    const fc = ferriesToGeoJSON([ferry({ lat: 41.0, lon: 9.5 })]);
    assert.deepEqual(fc.features[0].geometry.coordinates, [9.5, 41.0]);
  });

  it('marks an under-way vessel with a course as moving', () => {
    const fc = ferriesToGeoJSON([ferry({ status: 'under_way', courseDeg: 90 })]);
    assert.equal(fc.features[0].properties.moving, true);
    assert.equal(fc.features[0].properties.courseDeg, 90);
  });

  it('does not mark stationary vessels as moving', () => {
    const inPort = ferriesToGeoJSON([ferry({ status: 'in_port' })]);
    assert.equal(inPort.features[0].properties.moving, false);
    const anchored = ferriesToGeoJSON([ferry({ status: 'at_anchor' })]);
    assert.equal(anchored.features[0].properties.moving, false);
  });

  it('treats an under-way vessel with no course as not moving and courseDeg 0', () => {
    const fc = ferriesToGeoJSON([ferry({ status: 'under_way', courseDeg: undefined })]);
    assert.equal(fc.features[0].properties.moving, false);
    assert.equal(fc.features[0].properties.courseDeg, 0);
  });

  it('passes through display text; empties missing values', () => {
    const fc = ferriesToGeoJSON([ferry({ name: 'TIRRENIA', speedKnots: undefined, destinationName: undefined })]);
    const p = fc.features[0].properties;
    assert.equal(p.name, 'TIRRENIA');
    assert.equal(p.speedText, '—');
    assert.equal(p.destinationName, '');
  });

  it('formats speed and status label for the popup', () => {
    const fc = ferriesToGeoJSON([ferry({ status: 'at_anchor', speedKnots: 12 })]);
    const p = fc.features[0].properties;
    assert.equal(p.speedText, '12 kn');
    assert.equal(p.statusLabel, 'At anchor');
  });

  it('surfaces delay status: slipping, stalled, or empty', () => {
    const slip = ferriesToGeoJSON([ferry({ delay: { slipping: true, etaGrowthMin: 25 } })]);
    assert.equal(slip.features[0].properties.delayText, 'Delayed +25 min');
    const stall = ferriesToGeoJSON([ferry({ delay: { stalled: true } })]);
    assert.equal(stall.features[0].properties.delayText, 'Stalled');
    const none = ferriesToGeoJSON([ferry()]);
    assert.equal(none.features[0].properties.delayText, '');
  });

  it('surfaces the top delay reason as whyText (high-confidence weather)', () => {
    const fc = ferriesToGeoJSON([ferry({
      delay: {
        slipping: true,
        etaGrowthMin: 22,
        reasons: [
          { source: 'weather', kind: 'rough_seas', summary: 'Rough conditions (2.8 m seas)', confidence: 0.85 },
          { source: 'news', kind: 'strike', summary: 'Possible strike', confidence: 0.4 },
        ],
      },
    })]);
    assert.equal(fc.features[0].properties.whyText, '🌊 Rough conditions (2.8 m seas)');
  });

  it('hedges a low-confidence (news) reason and shows no whyText without reasons', () => {
    const news = ferriesToGeoJSON([ferry({
      delay: { slipping: true, reasons: [{ source: 'news', kind: 'strike', summary: 'Ferry strike reported', confidence: 0.4 }] },
    })]);
    assert.equal(news.features[0].properties.whyText, '📰 Possibly: Ferry strike reported');
    const noReasons = ferriesToGeoJSON([ferry({ delay: { slipping: true } })]);
    assert.equal(noReasons.features[0].properties.whyText, '');
  });
});
