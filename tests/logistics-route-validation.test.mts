import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  isKnownRoute,
  findRoute,
  routesTo,
  validateSailing,
} from '../src/services/logistics/route-validation.ts';

describe('route table lookups', () => {
  it('knows scheduled routes', () => {
    assert.equal(isKnownRoute('civitavecchia', 'olbia'), true);
    assert.equal(isKnownRoute('piombino', 'portoferraio'), true);
    assert.equal(isKnownRoute('olbia', 'civitavecchia'), false); // direction matters
    assert.equal(isKnownRoute('naples', 'reykjavik'), false);
  });

  it('returns the route with its operator', () => {
    assert.equal(findRoute('civitavecchia', 'olbia')?.operatorId, 'tirrenia');
    assert.equal(findRoute('milazzo', 'lipari')?.operatorId, 'siremar');
  });

  it('lists origins serving a destination', () => {
    const toOlbia = routesTo('olbia').map((r) => r.fromId).sort();
    assert.ok(toOlbia.includes('civitavecchia'));
    assert.ok(toOlbia.includes('genoa'));
    assert.ok(toOlbia.includes('livorno'));
  });
});

describe('validateSailing', () => {
  it('confirms a scheduled origin->destination pair', () => {
    const v = validateSailing({ originPortId: 'civitavecchia', destinationPortId: 'olbia', operatorId: 'tirrenia' });
    assert.equal(v.status, 'confirmed');
    assert.equal(v.operatorMatch, true);
    assert.equal(v.route?.operatorId, 'tirrenia');
  });

  it('confirms but flags an operator mismatch', () => {
    const v = validateSailing({ originPortId: 'civitavecchia', destinationPortId: 'olbia', operatorId: 'moby' });
    assert.equal(v.status, 'confirmed');
    assert.equal(v.operatorMatch, false);
    assert.match(v.note ?? '', /differs from scheduled/);
  });

  it('flags an unscheduled pair as unknown (anomaly)', () => {
    const v = validateSailing({ originPortId: 'naples', destinationPortId: 'cavo' });
    assert.equal(v.status, 'unknown');
    assert.match(v.note ?? '', /not in scheduled routes/);
  });

  it('is plausible when only a known destination is resolved', () => {
    assert.equal(validateSailing({ destinationPortId: 'olbia' }).status, 'plausible');
    assert.equal(validateSailing({ destinationPortId: 'catania' }).status, 'plausible'); // known port, no route in table
  });

  it('is unknown for an unrecognized or missing destination', () => {
    assert.equal(validateSailing({ destinationPortId: 'atlantis' }).status, 'unknown');
    assert.equal(validateSailing({}).status, 'unknown');
  });
});
