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
});
