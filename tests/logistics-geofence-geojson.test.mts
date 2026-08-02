import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { geofencesToGeoJSON, type Geofence } from '../src/services/logistics/geofences.ts';

function circleZone(overrides: Partial<Geofence> = {}, radiusKm = 8, lat = 51.95, lon = 4.13): Geofence {
  return {
    id: 'rotterdam',
    name: 'Rotterdam — port area',
    kind: 'port',
    geometry: { type: 'circle', center: { lat, lon }, radiusKm },
    ...overrides,
  };
}

function polygonZone(): Geofence {
  return {
    id: 'poly',
    name: 'Custom area',
    kind: 'custom',
    geometry: { type: 'polygon', ring: [{ lat: 51, lon: 4 }, { lat: 52, lon: 4 }, { lat: 52, lon: 5 }] },
  };
}

/**
 * The reference conversion, independent of the implementation: Web Mercator on MapLibre's
 * 512px-tile convention. metres-per-pixel = 78271.516 · cos(lat) / 2^zoom.
 */
function expectedRadiusPx(radiusKm: number, lat: number, zoom: number): number {
  const mpp = (78271.516 * Math.cos((lat * Math.PI) / 180)) / 2 ** zoom;
  return (radiusKm * 1000) / mpp;
}

describe('geofencesToGeoJSON', () => {
  it('emits one Polygon feature per zone', () => {
    const fc = geofencesToGeoJSON([circleZone(), polygonZone()]);
    assert.equal(fc.type, 'FeatureCollection');
    assert.equal(fc.features.length, 2);
    assert.equal(fc.features[0].geometry.type, 'Polygon');
  });

  it('carries radiusKm for circles and 0 for polygons, so the marker layer can select circles', () => {
    const fc = geofencesToGeoJSON([circleZone({}, 12), polygonZone()]);
    assert.equal(fc.features[0].properties.radiusKm, 12);
    assert.equal(fc.features[1].properties.radiusKm, 0);
    assert.equal(fc.features[1].properties.radiusPxAtZoom0, 0);
  });
});

describe('radiusPxAtZoom0 (the min-size zone marker)', () => {
  // radiusPxAtZoom0 × 2^zoom must be the TRUE on-screen radius at any zoom. The previous
  // expression used a fixed divisor of 50, which hardcodes latitude 50 and was +26% off at
  // Algeciras (36.1°N) — and made the ring visibly jump when the marker handed over to the
  // true geometry at z7.
  it('scales to the exact on-screen radius at every zoom', () => {
    const lat = 51.95;
    const radiusKm = 20;
    const [f] = geofencesToGeoJSON([circleZone({}, radiusKm, lat)]).features;
    for (const zoom of [0, 3, 3.473, 5, 7, 10, 14]) {
      const actual = f.properties.radiusPxAtZoom0 * 2 ** zoom;
      const expected = expectedRadiusPx(radiusKm, lat, zoom);
      assert.ok(
        Math.abs(actual - expected) < 1e-6,
        `z${zoom}: got ${actual.toFixed(4)}px, expected ${expected.toFixed(4)}px`,
      );
    }
  });

  it('is exact across the latitude span the relay actually serves (Algeciras → Teesport)', () => {
    // A fixed-latitude divisor is off by +26% at the south end and -9% at the north end.
    for (const lat of [36.13, 41.0, 45.44, 51.95, 54.6]) {
      const [f] = geofencesToGeoJSON([circleZone({}, 8, lat)]).features;
      const actual = f.properties.radiusPxAtZoom0 * 2 ** 7;
      const expected = expectedRadiusPx(8, lat, 7);
      const errPct = Math.abs(actual - expected) / expected * 100;
      assert.ok(errPct < 1e-6, `lat ${lat}: ${errPct.toFixed(3)}% error at the z7 handoff`);
    }
  });

  it('grows with radius and with latitude', () => {
    const px = (rk: number, lat: number) =>
      geofencesToGeoJSON([circleZone({}, rk, lat)]).features[0].properties.radiusPxAtZoom0;
    assert.ok(px(20, 51.95) > px(2.5, 51.95), 'a bigger zone must be a bigger mark');
    // Mercator stretches toward the poles, so the same radius covers more pixels further north.
    assert.ok(px(8, 54.6) > px(8, 36.13), 'same radius, higher latitude -> more pixels');
  });

  it('reproduces the measured default-view sizes that motivated the floor', () => {
    // At the board's fitted Europe default (z3.473) even the largest zone we carry is ~4.6px,
    // and the smallest ~0.5px — which is why the toggle looked like it did nothing.
    const at = (rk: number, lat: number) =>
      geofencesToGeoJSON([circleZone({}, rk, lat)]).features[0].properties.radiusPxAtZoom0 * 2 ** 3.473;
    assert.ok(Math.abs(at(20, 51.95) - 4.6) < 0.1, `Rotterdam ~4.6px, got ${at(20, 51.95).toFixed(2)}`);
    assert.ok(Math.abs(at(2.5, 45.44) - 0.51) < 0.05, `Venezia ~0.51px, got ${at(2.5, 45.44).toFixed(2)}`);
    assert.ok(at(20, 51.95) < 5, 'every real zone sits under the 5px floor at the default view');
  });
});
