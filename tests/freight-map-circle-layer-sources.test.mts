import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { geofenceMarkersToGeoJSON, geofencesToGeoJSON } from '../src/services/logistics/geofences.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const freightMap = readFileSync(resolve(__dirname, '../src/components/FreightMap.ts'), 'utf-8');

/**
 * A MapLibre `circle` layer draws a mark at EVERY VERTEX of the geometry it is handed —
 * CircleBucket does `for (const ring of geometry) for (const point of ring)`. Binding one to a
 * source of Polygons therefore does not render one circle per feature and does not render
 * nothing: it stamps a mark per ring vertex (64 per zone, with circleRing's default step count),
 * which at low zoom collapses into a filled blob.
 *
 * This shipped once, in the zone-marker layer, and unit tests on the GeoJSON builders could not
 * see it because the defect was in the layer→source WIRING. Hence a structural check.
 */
function addLayerBlocks(src: string): { id: string; type: string; source: string }[] {
  const out: { id: string; type: string; source: string }[] = [];
  const re = /addLayer\(\{([\s\S]*?)\n\s*\}\);/g;
  for (const m of src.matchAll(re)) {
    const body = m[1];
    const id = /\bid:\s*'([^']+)'/.exec(body)?.[1];
    const type = /\btype:\s*'([^']+)'/.exec(body)?.[1];
    const source = /\bsource:\s*([A-Za-z_$][\w$]*|'[^']+')/.exec(body)?.[1];
    if (id && type && source) out.push({ id, type, source });
  }
  return out;
}

/** Constant name → the builder that fills it, for the sources we can resolve statically. */
const SOURCE_GEOMETRY: Record<string, 'Point' | 'Polygon'> = {
  GEOFENCE_SOURCE_ID: 'Polygon',
  GEOFENCE_MARKER_SOURCE_ID: 'Point',
};

describe('FreightMap circle layers are fed point geometry', () => {
  const layers = addLayerBlocks(freightMap);

  it('parses the layer declarations it is meant to guard', () => {
    assert.ok(layers.length >= 3, `expected several addLayer blocks, found ${layers.length}`);
    assert.ok(layers.some((l) => l.id === 'geofence-marker'), 'geofence-marker layer not found');
  });

  it('binds the zone marker to the POINT source, not the zone polygons', () => {
    const marker = layers.find((l) => l.id === 'geofence-marker');
    assert.ok(marker);
    assert.equal(marker.type, 'circle');
    assert.equal(
      marker.source,
      'GEOFENCE_MARKER_SOURCE_ID',
      'a circle layer bound to the polygon source stamps one mark per ring vertex',
    );
  });

  it('no circle layer is bound to a source known to carry polygons', () => {
    for (const l of layers.filter((l) => l.type === 'circle')) {
      assert.notEqual(
        SOURCE_GEOMETRY[l.source],
        'Polygon',
        `circle layer "${l.id}" is bound to ${l.source}, which carries Polygon features`,
      );
    }
  });

  it('the two geofence builders really do emit the geometry this test assumes', () => {
    const zone = {
      id: 'z', name: 'Z', kind: 'port',
      geometry: { type: 'circle' as const, center: { lat: 51.95, lon: 4.13 }, radiusKm: 8 },
    };
    assert.equal(geofencesToGeoJSON([zone]).features[0].geometry.type, 'Polygon');
    assert.equal(geofenceMarkersToGeoJSON([zone]).features[0].geometry.type, 'Point');
  });
});
