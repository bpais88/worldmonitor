import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  ShipmentStore,
  parseShipmentCsv,
  type KeyValueStorage,
} from '../src/services/logistics/shipment-store.ts';

class MemStore implements KeyValueStorage {
  map = new Map<string, string>();
  getItem(k: string): string | null { return this.map.has(k) ? this.map.get(k)! : null; }
  setItem(k: string, v: string): void { this.map.set(k, v); }
}

describe('ShipmentStore', () => {
  it('adds, lists and removes shipments', () => {
    const store = new ShipmentStore(new MemStore());
    const s = store.add({ reference: 'BL123', containerNumbers: ['MSCU1234567'], destinationPortId: 'olbia' });
    assert.equal(store.list().length, 1);
    assert.equal(s.reference, 'BL123');
    assert.equal(s.legs[0]!.mode, 'ocean');
    assert.equal(s.legs[0]!.destinationPortId, 'olbia');
    assert.equal(s.legs[0]!.milestones[0]!.type, 'booked');

    store.remove(s.id);
    assert.equal(store.list().length, 0);
  });

  it('rejects a shipment with no reference', () => {
    const store = new ShipmentStore(new MemStore());
    assert.throws(() => store.add({ reference: '   ' }));
  });

  it('persists across store instances sharing storage', () => {
    const storage = new MemStore();
    new ShipmentStore(storage).add({ reference: 'PO-1' });
    assert.equal(new ShipmentStore(storage).list().length, 1);
  });

  it('imports shipments from CSV', () => {
    const store = new ShipmentStore(new MemStore());
    const csv = [
      'reference,container,origin,destination,imo,mmsi',
      'BL001,MSCU1,civitavecchia,olbia,9123456,247111111',
      'BL002,,naples,palermo,,',
    ].join('\n');
    const added = store.importCsv(csv);
    assert.equal(added.length, 2);
    assert.equal(store.list().length, 2);
    assert.equal(added[0]!.legs[0]!.vesselImo, '9123456');
    assert.equal(added[1]!.legs[0]!.destinationPortId, 'palermo');
  });
});

describe('parseShipmentCsv', () => {
  it('skips rows without a reference and honours quoted fields', () => {
    const csv = [
      'reference,container,destination',
      '"BL,777","CONT 1",olbia',
      ',NOREF,palermo',
    ].join('\n');
    const rows = parseShipmentCsv(csv);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.reference, 'BL,777');
    assert.equal(rows[0]!.containerNumbers?.[0], 'CONT 1');
  });

  it('returns empty for header-only or blank input', () => {
    assert.deepEqual(parseShipmentCsv('reference,container'), []);
    assert.deepEqual(parseShipmentCsv(''), []);
  });
});
