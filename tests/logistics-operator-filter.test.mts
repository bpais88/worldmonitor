import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  UNATTRIBUTED,
  hasOperator,
  tallyOperators,
  matchesOperatorFilter,
} from '../src/services/logistics/operator-filter.ts';
import type { TrackedFerry } from '../src/services/logistics/ferry-tracker.ts';

let seq = 0;
function ferry(overrides: Partial<TrackedFerry> = {}): TrackedFerry {
  seq += 1;
  return {
    mmsi: `2470000${seq}`,
    name: `VESSEL ${seq}`,
    lat: 41.0,
    lon: 9.5,
    status: 'under_way',
    courseDeg: 120,
    speedKnots: 18,
    etaTimestamp: null,
    hoursRemaining: null,
    confidence: 0,
    routeStatus: 'unknown',
    timestamp: 0,
    ...overrides,
  };
}

const msc = () => ferry({ operatorId: 'msc', operatorName: 'MSC' });
const maersk = () => ferry({ operatorId: 'maersk', operatorName: 'Maersk' });
/** The common real-world shape: AIS gives us a hull but nothing that resolves to an operator. */
const anon = () => ferry();

describe('hasOperator', () => {
  it('requires BOTH an id and a name — a half-populated record is not attributable', () => {
    assert.equal(hasOperator(msc()), true);
    assert.equal(hasOperator(anon()), false);
    assert.equal(hasOperator(ferry({ operatorId: 'msc' })), false);
    assert.equal(hasOperator(ferry({ operatorName: 'MSC' })), false);
    assert.equal(hasOperator(ferry({ operatorId: '', operatorName: 'MSC' })), false);
  });
});

describe('tallyOperators', () => {
  it('counts per operator and reports the unattributed remainder', () => {
    const t = tallyOperators([msc(), msc(), maersk(), anon(), anon(), anon()]);
    assert.equal(t.total, 6);
    assert.equal(t.attributed, 3);
    assert.equal(t.unattributed, 3);
    assert.deepEqual(t.operators, [
      { id: 'maersk', name: 'Maersk', count: 1 },
      { id: 'msc', name: 'MSC', count: 2 },
    ]);
  });

  it('sorts operators by display name, not by id or insertion order', () => {
    const t = tallyOperators([
      ferry({ operatorId: 'z', operatorName: 'Alpha' }),
      ferry({ operatorId: 'a', operatorName: 'Zulu' }),
      ferry({ operatorId: 'm', operatorName: 'Mike' }),
    ]);
    assert.deepEqual(t.operators.map((o) => o.name), ['Alpha', 'Mike', 'Zulu']);
  });

  it('attributed + unattributed always equals the total', () => {
    for (const set of [[], [anon()], [msc()], [msc(), anon(), maersk(), anon()]]) {
      const t = tallyOperators(set);
      assert.equal(t.attributed + t.unattributed, t.total, 'the denominator must account for every vessel');
    }
  });

  it('reports no unattributed vessels when every vessel resolves', () => {
    const t = tallyOperators([msc(), maersk()]);
    assert.equal(t.unattributed, 0);
  });
});

describe('matchesOperatorFilter', () => {
  it('the All chip (null) admits everything', () => {
    assert.equal(matchesOperatorFilter(msc(), null), true);
    assert.equal(matchesOperatorFilter(anon(), null), true);
  });

  it('an operator chip admits only that operator', () => {
    assert.equal(matchesOperatorFilter(msc(), 'msc'), true);
    assert.equal(matchesOperatorFilter(maersk(), 'msc'), false);
    assert.equal(matchesOperatorFilter(anon(), 'msc'), false);
  });

  it('the No-operator chip admits exactly the vessels no operator chip claims', () => {
    assert.equal(matchesOperatorFilter(anon(), UNATTRIBUTED), true);
    assert.equal(matchesOperatorFilter(msc(), UNATTRIBUTED), false);
  });

  it('does not let a half-populated record leak into a named operator chip', () => {
    // operatorId set but no name: not attributable, so it must fall to UNATTRIBUTED, never to 'msc'.
    const half = ferry({ operatorId: 'msc' });
    assert.equal(matchesOperatorFilter(half, 'msc'), false);
    assert.equal(matchesOperatorFilter(half, UNATTRIBUTED), true);
  });

  it('the sentinel cannot be produced by a real operator id', () => {
    // If a feed ever emitted this literal id it would hijack the No-operator chip.
    assert.match(UNATTRIBUTED, /^\[.*\]$/, 'sentinel must stay bracketed, unlike registry slugs');
  });
});

describe('the chip count and the chip filter agree (the bug this guards)', () => {
  // A chip that displays "64" and then lists a different number of rows is the exact failure
  // that motivated sharing one predicate. Assert it over a mixed, realistic population.
  const population = [
    ...Array.from({ length: 7 }, msc),
    ...Array.from({ length: 3 }, maersk),
    ...Array.from({ length: 25 }, anon),
    ferry({ operatorId: 'cma' }),                    // id only  -> unattributed
    ferry({ operatorName: 'Hapag' }),                // name only -> unattributed
  ];

  it('every operator chip lists exactly as many vessels as it claims', () => {
    const t = tallyOperators(population);
    for (const op of t.operators) {
      const shown = population.filter((f) => matchesOperatorFilter(f, op.id));
      assert.equal(shown.length, op.count, `chip "${op.name}" claims ${op.count} but lists ${shown.length}`);
    }
  });

  it('the No-operator chip lists exactly as many vessels as it claims', () => {
    const t = tallyOperators(population);
    const shown = population.filter((f) => matchesOperatorFilter(f, UNATTRIBUTED));
    assert.equal(shown.length, t.unattributed);
    assert.equal(t.unattributed, 27, 'the two half-populated records count as unattributed');
  });

  it('the chips partition the population — every vessel on exactly one chip', () => {
    const t = tallyOperators(population);
    const chips: (string | null)[] = [...t.operators.map((o) => o.id), UNATTRIBUTED];
    for (const f of population) {
      const hits = chips.filter((c) => matchesOperatorFilter(f, c));
      assert.equal(hits.length, 1, `${f.mmsi} matched ${hits.length} chips, expected exactly 1`);
    }
    const summed = t.operators.reduce((a, o) => a + o.count, 0) + t.unattributed;
    assert.equal(summed, t.total, 'chip counts must sum to the All count');
  });
});
