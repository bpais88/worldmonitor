import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ferryProps } from '../src/services/logistics/ferry-geojson';
import type { TrackedFerry } from '../src/services/logistics/ferry-tracker';

const ferry = (over: Partial<TrackedFerry> = {}): TrackedFerry => ({
  mmsi: '111', name: 'TEST', lat: 51, lon: 4, status: 'in_port', ...over,
} as TrackedFerry);

const rank = (over: Partial<TrackedFerry> = {}) => ferryProps(ferry(over)).labelRank;

describe('labelRank — which vessels get named when only ~5% of labels fit', () => {
  it('a stalled vessel outranks everything else', () => {
    // At the default view ~3,000 vessels compete for ~160 label slots. A ship that has stopped
    // moving is the story on a freight board; it must never lose that contest to a parked barge.
    assert.ok(rank({ delay: { stalled: true } }) > rank({ lengthMeters: 400, status: 'under_way' }));
  });

  it('a slipping ETA outranks a merely large vessel', () => {
    assert.ok(rank({ delay: { slipping: true } }) > rank({ lengthMeters: 300 }));
  });

  it('stalled outranks slipping', () => {
    assert.ok(rank({ delay: { stalled: true } }) > rank({ delay: { slipping: true } }));
  });

  it('bigger hulls outrank smaller ones', () => {
    assert.ok(rank({ lengthMeters: 300 }) > rank({ lengthMeters: 80 }));
  });

  it('size contribution is capped, so a giant cannot outrank a stalled ship', () => {
    // Without the cap, length/25 on a 400m hull would reach 16 and start competing with delay.
    assert.ok(rank({ lengthMeters: 10_000 }) < rank({ delay: { stalled: true } }));
  });

  it('unknown length scores nothing rather than NaN — most vessels have no length', () => {
    // Only ~39% of the live feed carries a length; NaN here would poison the sort for the majority.
    const r = rank({ lengthMeters: undefined });
    assert.ok(Number.isFinite(r), `expected a finite rank, got ${r}`);
    assert.equal(r, 0);
  });

  it('an under-way vessel outranks an identical one sitting in port', () => {
    assert.ok(rank({ status: 'under_way' }) > rank({ status: 'in_port' }));
  });
});
