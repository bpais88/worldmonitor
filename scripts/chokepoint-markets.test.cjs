'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { CHOKEPOINTS, extractMarkets, deriveSignal, buildChokepointEvents, fetchChokepointEvents } = require('./chokepoint-markets.cjs');

const HORMUZ = CHOKEPOINTS.find((c) => c.id === 'hormuz');

// Fixture mirroring the live gamma public-search response shape (captured 2026-07-16): the band
// cluster priced a collapse (73% on 0-20/day vs ~100 normal) plus a recovery market at 54%.
const liveShaped = () => ({
  events: [
    {
      title: 'Avg. # of ships transiting Strait of Hormuz end of July?',
      markets: [
        { question: 'Will there be between 0 and 20 average daily transits of the Strait of Hormuz', lastTradePrice: 0.733 },
        { question: 'Will there be between 20 and 40 average daily transits of the Strait of Hormuz', lastTradePrice: 0.17 },
        { question: 'Will there be between 40 and 60 average daily transits of the Strait of Hormuz', lastTradePrice: 0.041 },
      ],
    },
    {
      title: 'Strait of Hormuz traffic returns to normal by December 31?',
      markets: [{ question: 'Strait of Hormuz traffic returns to normal by December 31?', lastTradePrice: 0.54 }],
    },
    { // unrelated market noise must be ignored
      title: 'Which countries will send warships through the Strait of Hormuz by July 31?',
      markets: [{ question: 'Will France send warships through the Strait of Hormuz by July 31', lastTradePrice: 0.033 }],
    },
  ],
});

test('extracts daily transit bands and the recovery market, ignoring unrelated questions', () => {
  const ex = extractMarkets(liveShaped(), HORMUZ);
  assert.equal(ex.dailyBands.length, 3);
  assert.deepEqual(ex.dailyBands[0], { lo: 0, hi: 20, price: 0.733 });
  assert.equal(ex.weeklyBands.length, 0);
  assert.equal(ex.normalBy.price, 0.54);
  assert.match(ex.normalBy.label, /December 31/);
});

// Fixture mirroring the LIVE response the day this shipped (2026-07-17): the avg-daily cluster had
// rotated out of search; the signal was carried by a weekly market ("fewer than 100 ships this
// week" @ 0.97) — the reason the parser reads question FAMILIES, not one exact market.
const weeklyShaped = () => ({
  events: [
    {
      title: 'How many ships transit the Strait of Hormuz week of July 13?',
      markets: [
        { question: 'Will fewer than 100 ships transit the Strait of Hormuz between July 13-July 19?', lastTradePrice: 0.97 },
        { question: 'Will 100-124 ships transit the Strait of Hormuz between July 13-July 19?', lastTradePrice: 0.026 },
        { question: 'Will 125-149 ships transit the Strait of Hormuz between July 13-July 19?', lastTradePrice: 0.002 },
      ],
    },
    {
      title: 'Strait of Hormuz traffic returns to normal by December 31?',
      markets: [{ question: 'Strait of Hormuz traffic returns to normal by December 31?', lastTradePrice: 0.52 }],
    },
  ],
});

test('weekly family carries the signal when the avg-daily cluster is absent (live 2026-07-17 shape)', () => {
  const ex = extractMarkets(weeklyShaped(), HORMUZ);
  assert.equal(ex.dailyBands.length, 0);
  assert.equal(ex.weeklyBands.length, 3);
  assert.deepEqual(ex.weeklyBands[0], { lo: 0, hi: 100, price: 0.97 });
  const s = deriveSignal(ex, HORMUZ);
  assert.equal(s.state, 'severe');            // dominant weekly band 0-100/wk -> 0-14/day, hi <= 30% of normal
  assert.equal(s.basis, 'weekly');
  assert.equal(s.confidence, 0.97);
  assert.ok(s.impliedDailyTransits >= 5 && s.impliedDailyTransits <= 10, `implied ${s.impliedDailyTransits}`);
});

test('the daily family is preferred when both are present', () => {
  const both = { events: [...liveShaped().events, ...weeklyShaped().events] };
  const s = deriveSignal(extractMarkets(both, HORMUZ), HORMUZ);
  assert.equal(s.basis, 'avg-daily');
});

test('the July 2026 collapse reads as severe with market confidence, implied ~15/day', () => {
  const s = deriveSignal(extractMarkets(liveShaped(), HORMUZ), HORMUZ);
  assert.equal(s.state, 'severe');           // dominant band 0-20 ≤ 30% of 100 normal
  assert.equal(s.confidence, 0.73);
  assert.ok(s.impliedDailyTransits >= 12 && s.impliedDailyTransits <= 18, `implied ${s.impliedDailyTransits}`);
});

test('state thresholds are relative to normal flow', () => {
  const at = (lo, hi, price) => deriveSignal({ dailyBands: [{ lo, hi, price }], weeklyBands: [], normalBy: null }, HORMUZ).state;
  assert.equal(at(0, 30, 0.8), 'severe');      // hi 30 = 30% of 100
  assert.equal(at(20, 40, 0.8), 'disrupted');  // hi 40 ≤ 60%
  assert.equal(at(40, 60, 0.8), 'disrupted');  // hi 60 = 60%
  assert.equal(at(60, 80, 0.8), 'normal');
});

test('no readable markets, or a dead cluster, yields NO signal — never "all clear"', () => {
  assert.equal(deriveSignal(extractMarkets({ events: [] }, HORMUZ), HORMUZ), null);
  assert.equal(deriveSignal({ dailyBands: [{ lo: 0, hi: 20, price: 0.01 }], weeklyBands: [], normalBy: null }, HORMUZ), null);
  assert.equal(deriveSignal(null, HORMUZ), null);
});

test('events are generic-source, hedged, stable-id, and pull-only by construction', () => {
  const s = deriveSignal(extractMarkets(liveShaped(), HORMUZ), HORMUZ);
  const evs = buildChokepointEvents(s, HORMUZ, 1_000);
  assert.equal(evs.length, 1);
  const e = evs[0];
  assert.equal(e.id, 'market:hormuz:severe');            // stable per (chokepoint, state) for first-seen logging
  assert.equal(e.kind, 'chokepoint_disruption');
  assert.equal(e.source, 'market-implied');
  assert.equal(e.startsAt, null);                        // never enters the watch push window
  assert.equal(e.country, null);                         // stays out of ?country=/?port= filters
  assert.match(e.summary, /Market-implied/);
  assert.match(e.summary, /public prediction markets imply ~1[2-8] transits\/day vs ~100 normal/);
  assert.match(e.summary, /recovery by December 31.*54%/);
  assert.match(e.summary, /Not a measured count\./);
  // Owner decision: the vendor is never named in anything customer-facing.
  assert.ok(!JSON.stringify(e).toLowerCase().includes('polymarket'), 'vendor name must not leak into served events');
});

test('a normal state produces no events (no noise when nothing is wrong)', () => {
  const s = deriveSignal({ dailyBands: [{ lo: 80, hi: 120, price: 0.9 }], weeklyBands: [], normalBy: null }, HORMUZ);
  assert.equal(s.state, 'normal');
  assert.deepEqual(buildChokepointEvents(s, HORMUZ), []);
});

test('fetchChokepointEvents: failure degrades to [] (absence of signal), success builds events', async () => {
  const failing = async () => { throw new Error('ECONNRESET'); };
  assert.deepEqual(await fetchChokepointEvents(failing), []);
  const ok = async () => ({ ok: true, json: async () => liveShaped() });
  const evs = await fetchChokepointEvents(ok, 5_000);
  assert.equal(evs.length, 1);
  assert.equal(evs[0].id, 'market:hormuz:severe');
  const notOk = async () => ({ ok: false, status: 502 });
  assert.deepEqual(await fetchChokepointEvents(notOk), []);
});

test('bands from different WEEKS are never pooled — the most liquid single week wins', () => {
  const twoWeeks = { events: [
    { title: 'How many ships transit the Strait of Hormuz week of July 13?',
      markets: [
        { question: 'Will fewer than 100 ships transit the Strait of Hormuz between July 13-July 19?', lastTradePrice: 0.97 },
        { question: 'Will 100-124 ships transit the Strait of Hormuz between July 13-July 19?', lastTradePrice: 0.026 },
      ] },
    { title: 'How many ships transit the Strait of Hormuz week of July 20?',
      markets: [
        { question: 'Will fewer than 150 ships transit the Strait of Hormuz between July 20-July 26?', lastTradePrice: 0.995 },
        { question: 'Will 150-174 ships transit the Strait of Hormuz between July 20-July 26?', lastTradePrice: 0.039 },
      ] },
  ] };
  const ex = extractMarkets(twoWeeks, HORMUZ);
  assert.equal(ex.weeklyBands.length, 2);                 // one event's cluster, not 4 pooled bands
  assert.equal(ex.weeklyBands[0].hi, 150);                // the heavier-mass week won
  const s = deriveSignal(ex, HORMUZ);
  assert.equal(s.state, 'severe');
  assert.equal(s.confidence, 0.99);                       // floored from 0.995, never 1
});
