import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  findNearestPort,
  computePortState,
  detectPortEvent,
  portEventToMilestone,
  PortCallTracker,
} from '../src/services/logistics/port-call.ts';
import type { LiveVessel } from '../src/services/logistics/providers/types.ts';

function at(lat: number, lon: number, speedKnots: number, t = 0): LiveVessel {
  return { mmsi: '247000123', name: 'TOREMAR ELBA', lat, lon, category: 'passenger', speedKnots, timestamp: t };
}

// Civitavecchia 42.09,11.79 -> Olbia 40.92,9.51 ; open Tyrrhenian midpoint.
const CIVITAVECCHIA = { lat: 42.09, lon: 11.79 };
const OLBIA = { lat: 40.92, lon: 9.51 };
const OPEN_SEA = { lat: 41.5, lon: 10.65 };

describe('findNearestPort', () => {
  it('finds a port when within range', () => {
    const r = findNearestPort(CIVITAVECCHIA.lat, CIVITAVECCHIA.lon);
    assert.equal(r?.port.id, 'civitavecchia');
  });
  it('returns nothing in open sea', () => {
    assert.equal(findNearestPort(OPEN_SEA.lat, OPEN_SEA.lon), undefined);
  });
});

describe('computePortState', () => {
  it('is at port only when slow inside the radius', () => {
    assert.equal(computePortState(at(CIVITAVECCHIA.lat, CIVITAVECCHIA.lon, 0)).atPortId, 'civitavecchia');
    // Fast over the same spot = transiting, not berthed.
    assert.equal(computePortState(at(CIVITAVECCHIA.lat, CIVITAVECCHIA.lon, 18)).atPortId, null);
    assert.equal(computePortState(at(OPEN_SEA.lat, OPEN_SEA.lon, 18)).atPortId, null);
  });
});

describe('detectPortEvent', () => {
  it('emits departed then arrived across a crossing', () => {
    const s0 = computePortState(at(CIVITAVECCHIA.lat, CIVITAVECCHIA.lon, 0, 0)); // moored Civitavecchia
    const s1 = computePortState(at(OPEN_SEA.lat, OPEN_SEA.lon, 18, 1));          // under way
    const s2 = computePortState(at(OLBIA.lat, OLBIA.lon, 1, 2));                 // moored Olbia

    const depart = detectPortEvent(s0, s1);
    assert.equal(depart?.type, 'departed');
    assert.equal(depart?.portId, 'civitavecchia');

    const arrive = detectPortEvent(s1, s2);
    assert.equal(arrive?.type, 'arrived');
    assert.equal(arrive?.portId, 'olbia');
  });

  it('emits nothing when state is unchanged', () => {
    const s = computePortState(at(CIVITAVECCHIA.lat, CIVITAVECCHIA.lon, 0));
    assert.equal(detectPortEvent(s, s), null);
  });
});

describe('PortCallTracker', () => {
  it('tracks a full Civitavecchia -> Olbia sailing', () => {
    const tracker = new PortCallTracker();
    const events = [
      at(CIVITAVECCHIA.lat, CIVITAVECCHIA.lon, 0, 0),
      at(OPEN_SEA.lat, OPEN_SEA.lon, 18, 1),
      at(OLBIA.lat, OLBIA.lon, 0, 2),
    ].map((v) => tracker.update(v));

    assert.equal(events[0], null); // first sighting, no transition
    assert.equal(events[1]?.type, 'departed');
    assert.equal(events[2]?.type, 'arrived');
    assert.equal(tracker.currentPort('247000123'), 'olbia');
  });
});

describe('portEventToMilestone', () => {
  it('maps an arrival event to a milestone', () => {
    const m = portEventToMilestone({
      mmsi: '247000123', type: 'arrived', portId: 'olbia', portName: 'Olbia', at: 123,
    });
    assert.equal(m.type, 'arrived');
    assert.equal(m.portId, 'olbia');
    assert.match(m.note ?? '', /Arrived Olbia/);
  });
});
