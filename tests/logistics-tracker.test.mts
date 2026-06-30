import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildFerryBoard,
  toTrackedFerry,
  sortFerries,
  getTrackedFreightVessels,
} from '../src/services/logistics/ferry-tracker.ts';
import type { LiveVessel } from '../src/services/logistics/providers/types.ts';
import type { VesselDataProvider } from '../src/services/logistics/providers/types.ts';

function vessel(over: Partial<LiveVessel>): LiveVessel {
  return {
    mmsi: '247000000',
    name: 'MOBY DADA',
    lat: 42.5,
    lon: 10.4,
    category: 'passenger',
    shipType: 60, // Italian-flag (247) + passenger type => recognised as a ferry
    timestamp: 0,
    ...over,
  };
}

describe('toTrackedFerry', () => {
  it('resolves operator, destination and ETA for an under-way ferry', () => {
    const now = 1_700_000_000_000;
    const v = vessel({
      name: 'MOBY DADA',
      lat: 42.09, lon: 11.79, // off Civitavecchia
      destination: 'OLBIA',
      speedKnots: 20,
      navStatus: 0,
    });
    const f = toTrackedFerry(v, now);
    assert.equal(f.operatorId, 'moby');
    assert.equal(f.operatorName, 'Moby Lines');
    assert.equal(f.destinationPortId, 'olbia');
    assert.equal(f.destinationGroup, 'Sardinia');
    assert.equal(f.status, 'under_way');
    assert.ok(f.hoursRemaining && f.hoursRemaining > 0);
    // Olbia is a known ferry destination -> plausible (no origin in a snapshot).
    assert.equal(f.routeStatus, 'plausible');
  });

  it('marks a moored vessel as in port with no ETA', () => {
    const f = toTrackedFerry(vessel({ navStatus: 5, speedKnots: 0, destination: 'OLBIA' }));
    assert.equal(f.status, 'in_port');
    assert.equal(f.hoursRemaining, null);
  });

  it('treats nav status 1 as at anchor', () => {
    const f = toTrackedFerry(vessel({ navStatus: 1, speedKnots: 0 }));
    assert.equal(f.status, 'at_anchor');
  });
});

describe('buildFerryBoard', () => {
  it('keeps freight vessels (cargo + RoPax operators), drops tourist/cruise', () => {
    const vessels: LiveVessel[] = [
      vessel({ mmsi: '247111111', name: 'GNV ATLAS', speedKnots: 18, destination: 'PALERMO' }),       // RoPax freight operator
      vessel({ mmsi: '636000000', name: 'EVER GIVEN', category: 'cargo', shipType: 70, speedKnots: 12 }), // cargo => freight
      vessel({ mmsi: '247222222', name: 'CAREMAR ISCHIA', speedKnots: 0, navStatus: 5 }),              // tourist passenger
    ];
    const board = buildFerryBoard(vessels);
    const names = board.map((f) => f.name);
    assert.ok(names.includes('GNV ATLAS'));
    assert.ok(names.includes('EVER GIVEN'));        // cargo is freight
    assert.ok(!names.includes('CAREMAR ISCHIA'));   // tourist excluded
  });

  it('sorts under-way freight vessels ahead of in-port ones', () => {
    const board = buildFerryBoard([
      vessel({ mmsi: '247222222', name: 'GNV PORT', navStatus: 5, speedKnots: 0 }),
      vessel({ mmsi: '247111111', name: 'GNV SEA', speedKnots: 18, destination: 'OLBIA', lat: 42.09, lon: 11.79 }),
    ]);
    assert.equal(board[0]!.name, 'GNV SEA');
    assert.equal(board[1]!.name, 'GNV PORT');
  });
});

describe('sortFerries', () => {
  it('orders by status then ETA', () => {
    const base = toTrackedFerry(vessel({ name: 'A', navStatus: 5, speedKnots: 0 }));
    const fast = toTrackedFerry(vessel({ name: 'B', speedKnots: 25, destination: 'OLBIA', lat: 42.09, lon: 11.79 }));
    assert.ok(sortFerries(fast, base) < 0);
  });
});

describe('getTrackedFreightVessels', () => {
  it('queries the provider with the Europe-wide bbox + freight categories', async () => {
    let captured: unknown;
    const mockProvider: VesselDataProvider = {
      id: 'mock',
      async getVesselsInBounds(query) {
        captured = query;
        return [vessel({ name: 'GNV RHAPSODY', speedKnots: 16, destination: 'PORTO TORRES' })];
      },
    };
    const board = await getTrackedFreightVessels(mockProvider);
    assert.equal(board.length, 1);
    assert.equal(board[0]!.destinationPortId, 'porto_torres');
    // The union box across Italy + UK + Spain + Netherlands (see EUROPE_BBOX).
    assert.deepEqual((captured as { bbox: number[] }).bbox, [34.0, -11.5, 61.0, 20.0]);
    assert.deepEqual((captured as { categories: string[] }).categories, ['cargo', 'passenger']);
    assert.equal((captured as { freight: boolean }).freight, true);
  });
});
