import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { levelFor, portsToGeoJSON } from '../src/services/logistics/ports-geojson';
import type { PortStatus } from '../src/services/logistics/port-status';

const port = (over: Partial<PortStatus> = {}): PortStatus => ({
  portId: 'rotterdam',
  name: 'Rotterdam',
  lat: 51.95,
  lon: 4.14,
  region: 'South Holland',
  atPort: 10,
  atAnchor: 0,
  atBerth: 10,
  inbound: 3,
  inboundEta: { h6: 0, h12: 1, h24: 2, h48: 3 },
  congestion: 'congested',
  congestionRel: 'clear',
  coverageOk: true,
  source: 'aisstream',
  ...over,
});

describe('levelFor — what colour a port is drawn', () => {
  it('prefers congestionRel over the absolute label', () => {
    // The absolute label is measured against fleet-wide thresholds calibrated on Italian
    // terminals, so it calls Rotterdam "congested" on an ordinary day. congestionRel compares the
    // port to its OWN baseline. The map must show the one that means the same thing everywhere.
    assert.equal(levelFor(port({ congestion: 'congested', congestionRel: 'clear' })), 'clear');
  });

  it('falls back to the absolute label when the baseline has not filled yet', () => {
    assert.equal(levelFor(port({ congestion: 'busy', congestionRel: null })), 'busy');
  });

  it('NO COVERAGE beats everything — never draw a blind spot as clear', () => {
    // The Lisbon bug (#125): a port nothing could see reported "congestion clear" with residual
    // counts. Whatever the counts say, an uncovered port is unknown.
    assert.equal(levelFor(port({ coverageOk: false, congestion: 'clear', congestionRel: 'clear' })), 'unknown');
    assert.equal(levelFor(port({ coverageOk: false, congestion: 'congested', congestionRel: 'busy' })), 'unknown');
  });

  it('is unknown when there is nothing to report at all', () => {
    assert.equal(
      levelFor({ coverageOk: true, congestion: undefined as never, congestionRel: null }),
      'unknown',
    );
  });
});

describe('portsToGeoJSON', () => {
  it('emits one Point per port, lon/lat ordered for GeoJSON', () => {
    const fc = portsToGeoJSON([port()]);
    assert.equal(fc.features.length, 1);
    const f = fc.features[0]!;
    assert.equal(f.geometry.type, 'Point');
    assert.deepEqual((f.geometry as GeoJSON.Point).coordinates, [4.14, 51.95]);
  });

  it('skips ports without usable coordinates rather than emitting NaN geometry', () => {
    const fc = portsToGeoJSON([
      port({ portId: 'ok' }),
      port({ portId: 'nolat', lat: NaN }),
      port({ portId: 'nolon', lon: undefined as never }),
    ]);
    assert.deepEqual(fc.features.map((f) => f.properties?.portId), ['ok']);
  });

  it('labels the anchor queue only when there is one', () => {
    const withQueue = portsToGeoJSON([port({ atAnchor: 3 })]).features[0]!.properties!;
    const noQueue = portsToGeoJSON([port({ atAnchor: 0 })]).features[0]!.properties!;
    assert.match(String(withQueue.label), /3 waiting/);
    assert.doesNotMatch(String(noQueue.label), /waiting/);
  });

  it('says so on the label when a port is not visible', () => {
    const dark = portsToGeoJSON([port({ coverageOk: false })]).features[0]!.properties!;
    assert.match(String(dark.label), /no coverage/);
    assert.equal(dark.level, 'unknown');
    assert.equal(dark.coverageOk, false);
  });

  it('defaults missing counts to 0 so the radius expression never sees undefined', () => {
    const p = portsToGeoJSON([port({ atPort: undefined as never, atAnchor: undefined as never })])
      .features[0]!.properties!;
    assert.equal(p.atPort, 0);
    assert.equal(p.atAnchor, 0);
  });

  it('tolerates an empty list', () => {
    assert.deepEqual(portsToGeoJSON([]), { type: 'FeatureCollection', features: [] });
  });
});
