import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { etaView, coverageNote } from './freight.mjs';

const NOW = Date.parse('2026-06-22T21:00:00Z');

test('no ETA when the vessel is stopped / at port (no etaTs)', () => {
  assert.deepEqual(etaView({ name: 'X' }, NOW), {});
  assert.deepEqual(etaView({ etaTs: null }, NOW), {});
});

test('moving vessel: live ETA + hours remaining, no trend without delta', () => {
  const r = etaView({ etaTs: Date.parse('2026-06-23T04:00:00Z') }, NOW);
  assert.equal(r.eta, '2026-06-23 04:00Z');
  assert.equal(r.etaInHours, 7);
  assert.equal('etaTrendMin' in r, false); // no trend data → field omitted, not 0
});

test('multi-day ETA carries a copy-ready calendar date', () => {
  // The Lisbon regression: these two are the exact prod values. The hours ("~44h", "~74h") were
  // transcribed correctly but the dates were both written a day early, so the day is now spelled
  // out rather than left to be derived from the ISO string or from etaInHours.
  const now = Date.parse('2026-07-25T17:09:00Z');
  const a = etaView({ etaTs: Date.parse('2026-07-27T12:49:00Z') }, now);
  assert.equal(a.etaInHours, 43.7);
  assert.equal(a.eta, '2026-07-27 12:49Z');
  assert.equal(a.etaDay, 'Mon 27 Jul');   // NOT 26 Jul — the day the ETA actually lands on

  const b = etaView({ etaTs: Date.parse('2026-07-28T19:01:00Z') }, now);
  assert.equal(b.etaInHours, 73.9);
  assert.equal(b.etaDay, 'Tue 28 Jul');
});

test('etaDay is stamped in UTC, not the host timezone', () => {
  // 23:30Z is "tomorrow" in any positive-offset host tz — the day must follow the Z time.
  const r = etaView({ etaTs: Date.parse('2026-07-27T23:30:00Z') }, Date.parse('2026-07-27T12:00:00Z'));
  assert.equal(r.etaDay, 'Mon 27 Jul');
});

test('slipping later: positive signed trend with its window', () => {
  const r = etaView({ etaTs: Date.parse('2026-06-22T22:20:00Z'), etaDeltaMin: 20, etaWindowMin: 60 }, NOW);
  assert.equal(r.etaTrendMin, 20);       // + = arriving later
  assert.equal(r.etaTrendWindowMin, 60);
});

test('running ahead: negative signed trend is preserved', () => {
  const r = etaView({ etaTs: Date.parse('2026-06-22T21:50:00Z'), etaDeltaMin: -10, etaWindowMin: 45 }, NOW);
  assert.equal(r.etaTrendMin, -10);      // − = ahead of earlier estimate
  assert.equal(r.etaTrendWindowMin, 45);
});

test('vs-departure drift + voyage age surfaced when present', () => {
  const r = etaView({
    etaTs: Date.parse('2026-06-22T23:40:00Z'),
    etaVsDepartureMin: 40, voyageAgeMin: 240,
  }, NOW);
  assert.equal(r.etaVsDepartureMin, 40);  // +40 min later than the departure ETA
  assert.equal(r.voyageAgeMin, 240);      // 4h into the trip
});

test('fully covered ports produce no coverage note', () => {
  assert.equal(coverageNote([{ name: 'Genoa', coverageOk: true }, { name: 'Lisboa', coverageOk: true }]), null);
});

test('an older relay that omits coverageOk is treated as covered, not dark', () => {
  assert.equal(coverageNote([{ name: 'Genoa' }, { name: 'Lisboa' }]), null);
});

test('an uncovered port is named, so it cannot be reported as "clear"', () => {
  // The Lisbon case: aisstream dark + the Italy-only fallback ⇒ PT invisible, but the port row
  // still carries last-known counts and congestion "clear".
  const n = coverageNote([
    { name: 'Genoa', coverageOk: true },
    { name: 'Lisboa', coverageOk: false, congestion: 'clear' },
  ]);
  assert.deepEqual(n.uncovered, ['Lisboa']);
  assert.match(n.note, /No live AIS coverage/);
  assert.match(n.note, /Lisboa/);
});

test('coverage note is empty-safe', () => {
  assert.equal(coverageNote(undefined), null);
  assert.equal(coverageNote([]), null);
});
