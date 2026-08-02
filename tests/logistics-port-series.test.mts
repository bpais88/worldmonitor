import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildPortSeriesQuery,
  parsePortSeries,
  valueAt,
  rangeFor,
  type PortSeries,
} from '../src/services/logistics/port-series.ts';

function series(overrides: Partial<PortSeries> = {}): PortSeries {
  return {
    ts: [1000, 2000, 3000],
    ports: { rotterdam: { atBerth: [5, null, 9] }, savona: { atBerth: [1, 2, 3] } },
    fields: ['atBerth'],
    hours: 48,
    stepMin: 15,
    tickCount: 3,
    portCount: 2,
    generatedAt: 0,
    db: true,
    ...overrides,
  };
}

describe('buildPortSeriesQuery', () => {
  it('omits everything when nothing is asked for', () => {
    assert.equal(buildPortSeriesQuery(), '');
    assert.equal(buildPortSeriesQuery({}), '');
  });

  it('serialises each supported parameter', () => {
    assert.equal(buildPortSeriesQuery({ hours: 24 }), '?hours=24');
    assert.equal(buildPortSeriesQuery({ stepMin: 5 }), '?stepMin=5');
    assert.equal(buildPortSeriesQuery({ ports: ['rotterdam', 'savona'] }), '?ports=rotterdam%2Csavona');
    assert.equal(buildPortSeriesQuery({ fields: ['atBerth', 'atPort'] }), '?fields=atBerth%2CatPort');
  });

  it('drops empty lists rather than sending an empty parameter', () => {
    assert.equal(buildPortSeriesQuery({ ports: [], fields: [] }), '');
  });

  it('keeps hours=0 out but stepMin explicit — non-finite values are never sent', () => {
    assert.equal(buildPortSeriesQuery({ hours: Number.NaN }), '');
    assert.equal(buildPortSeriesQuery({ stepMin: Number.POSITIVE_INFINITY }), '');
  });
});

describe('parsePortSeries', () => {
  // The wire shape mirrors db.queryPortSeries: a shared ts axis plus columnar per-port arrays.
  const wire = {
    ts: [1000, 2000, 3000],
    ports: { rotterdam: { atBerth: [5, null, 9], atPort: [10, null, 18] } },
    fields: ['atBerth', 'atPort'],
    hours: 48, stepMin: 15, tickCount: 3, portCount: 1, generatedAt: 123, db: true,
  };

  it('round-trips a well-formed payload', () => {
    const s = parsePortSeries(wire);
    assert.deepEqual(s.ts, [1000, 2000, 3000]);
    assert.deepEqual(s.ports.rotterdam.atBerth, [5, null, 9]);
    assert.deepEqual(s.fields, ['atBerth', 'atPort']);
    assert.equal(s.stepMin, 15);
    assert.equal(s.db, true);
  });

  it('pads a SHORT array to the ts length — a desync would misalign playback', () => {
    const s = parsePortSeries({ ...wire, ports: { p: { atBerth: [1] } } });
    assert.deepEqual(s.ports.p.atBerth, [1, null, null]);
  });

  it('truncates a LONG array to the ts length', () => {
    const s = parsePortSeries({ ...wire, ports: { p: { atBerth: [1, 2, 3, 4, 5] } } });
    assert.deepEqual(s.ports.p.atBerth, [1, 2, 3]);
  });

  it('ignores fields the relay did not declare', () => {
    const s = parsePortSeries({ ...wire, fields: ['atBerth'], ports: { p: { atBerth: [1, 2, 3], inbound: [9, 9, 9] } } });
    assert.deepEqual(s.ports.p.atBerth, [1, 2, 3]);
    assert.equal(s.ports.p.inbound, undefined);
  });

  it('drops unknown field names rather than trusting the payload', () => {
    const s = parsePortSeries({ ...wire, fields: ['atBerth', 'evil'] });
    assert.deepEqual(s.fields, ['atBerth']);
  });

  it('coerces non-finite values to null, keeping zero', () => {
    const s = parsePortSeries({ ...wire, fields: ['atBerth'], ports: { p: { atBerth: [0, 'x', null] } } });
    assert.deepEqual(s.ports.p.atBerth, [0, null, null]);
  });

  it('survives an empty or malformed payload without throwing', () => {
    for (const bad of [undefined, null, {}, { ts: 'nope' }, { ports: 'nope' }]) {
      const s = parsePortSeries(bad);
      assert.deepEqual(s.ts, []);
      assert.deepEqual(s.ports, {});
      assert.equal(s.tickCount, 0);
    }
  });

  it('reports db:false when the relay has no database', () => {
    assert.equal(parsePortSeries({ ...wire, db: false }).db, false);
    assert.equal(parsePortSeries(wire).db, true);
  });
});

describe('valueAt', () => {
  it('reads the value at a frame', () => {
    assert.equal(valueAt(series(), 'rotterdam', 0), 5);
    assert.equal(valueAt(series(), 'rotterdam', 2), 9);
  });

  it('returns null for a frame with no fresh reading', () => {
    assert.equal(valueAt(series(), 'rotterdam', 1), null);
  });

  it('returns null out of range rather than undefined', () => {
    assert.equal(valueAt(series(), 'rotterdam', -1), null);
    assert.equal(valueAt(series(), 'rotterdam', 99), null);
  });

  it('returns null for an unknown port or field', () => {
    assert.equal(valueAt(series(), 'nowhere', 0), null);
    assert.equal(valueAt(series(), 'rotterdam', 0, 'inbound'), null);
  });

  it('does not confuse a genuine zero with a missing frame', () => {
    const s = series({ ports: { p: { atBerth: [0, null] } } });
    assert.equal(valueAt(s, 'p', 0), 0);
    assert.equal(valueAt(s, 'p', 1), null);
    assert.notEqual(valueAt(s, 'p', 0), valueAt(s, 'p', 1));
  });
});

describe('rangeFor', () => {
  // The replay scales each port against ITSELF — raw counts are not comparable between ports,
  // but across one port's own timeline the size difference is constant and cancels out.
  it('reports a port\'s own min and max, skipping null frames', () => {
    assert.deepEqual(rangeFor(series(), 'rotterdam'), { min: 5, max: 9 });
    assert.deepEqual(rangeFor(series(), 'savona'), { min: 1, max: 3 });
  });

  it('includes a genuine zero in the range', () => {
    const s = series({ ports: { p: { atBerth: [0, 4] } } });
    assert.deepEqual(rangeFor(s, 'p'), { min: 0, max: 4 });
  });

  it('returns null when the port has no readings at all', () => {
    const s = series({ ports: { p: { atBerth: [null, null] } } });
    assert.equal(rangeFor(s, 'p'), null);
  });

  it('returns null for an unknown port or field', () => {
    assert.equal(rangeFor(series(), 'nowhere'), null);
    assert.equal(rangeFor(series(), 'rotterdam', 'atPort'), null);
  });

  it('handles a single-reading port without producing an infinite range', () => {
    const s = series({ ports: { p: { atBerth: [null, 3, null] } } });
    assert.deepEqual(rangeFor(s, 'p'), { min: 3, max: 3 });
  });
});
