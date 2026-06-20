import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { shipTypeCategory } from '../src/services/logistics/classify.ts';
import {
  toLiveVessel,
  buildVesselsQueryString,
  type RawRelayVessel,
} from '../src/services/logistics/providers/aisstream.ts';

describe('shipTypeCategory', () => {
  it('buckets AIS ship-type ranges', () => {
    assert.equal(shipTypeCategory(60), 'passenger');
    assert.equal(shipTypeCategory(69), 'passenger');
    assert.equal(shipTypeCategory(70), 'cargo');
    assert.equal(shipTypeCategory(80), 'tanker');
    assert.equal(shipTypeCategory(40), 'hsc');
    assert.equal(shipTypeCategory(30), 'other');
    assert.equal(shipTypeCategory(undefined), 'other');
  });
});

describe('buildVesselsQueryString', () => {
  it('serializes bbox, types and limit', () => {
    const qs = buildVesselsQueryString({
      bbox: [35, 6, 46.5, 19.5],
      categories: ['passenger', 'hsc'],
      limit: 1000,
    });
    assert.match(qs, /^\?/);
    const params = new URLSearchParams(qs.slice(1));
    assert.equal(params.get('bbox'), '35,6,46.5,19.5');
    assert.equal(params.get('types'), 'passenger,hsc');
    assert.equal(params.get('limit'), '1000');
  });

  it('returns empty string for an empty query', () => {
    assert.equal(buildVesselsQueryString({}), '');
  });
});

describe('toLiveVessel', () => {
  it('maps a raw relay vessel into the LiveVessel shape', () => {
    const raw: RawRelayVessel = {
      mmsi: '247123456',
      name: 'MOBY DADA',
      lat: 42.8,
      lon: 10.3,
      speed: 18.2,
      course: 175,
      heading: 176,
      navStatus: 0,
      shipType: 60,
      category: 'passenger',
      imo: '9123456',
      destination: 'PORTOFERRAIO',
      timestamp: 1_700_000_000_000,
    };
    const v = toLiveVessel(raw);
    assert.ok(v);
    assert.equal(v!.mmsi, '247123456');
    assert.equal(v!.speedKnots, 18.2);
    assert.equal(v!.courseDeg, 175);
    assert.equal(v!.category, 'passenger');
    assert.equal(v!.destination, 'PORTOFERRAIO');
    assert.equal(v!.navStatus, 0);
  });

  it('derives category from shipType when the relay omits it', () => {
    const v = toLiveVessel({ mmsi: '247000001', lat: 40, lon: 14, shipType: 70 });
    assert.equal(v!.category, 'cargo');
  });

  it('rejects rows without a usable position', () => {
    assert.equal(toLiveVessel({ mmsi: '247', lat: NaN, lon: 10 } as RawRelayVessel), null);
    assert.equal(toLiveVessel({ mmsi: '', lat: 40, lon: 14 } as RawRelayVessel), null);
  });
});
