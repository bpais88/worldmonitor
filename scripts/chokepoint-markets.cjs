'use strict';

// M6 v1 — market-implied chokepoint disruption signal (scope: assistant/DISRUPTION_SOURCES_SCOPE.md, PR #112).
//
// WHY MARKETS: straits are not water-level problems and our AIS feed has ZERO coverage in the
// Persian Gulf / Bab el-Mandeb (verified 2026-07-16 — terrestrial network, no receivers), while
// satellite AIS is a sales-gated duopoly with no verified <$1k entry (deep-research 2026-07-17).
// Public prediction markets on chokepoint transit counts are resolved against professional tanker
// tracking and priced continuously with real liquidity — the cheapest credible transit proxy that
// exists. We read the prices; someone else pays the tracking bill.
//
// SOURCE LABELING (owner decision 2026-07-17): customer-facing events say `source: 'market-implied'`
// and "public prediction markets" — never a vendor name. Provenance (exact market questions +
// prices) goes to the relay log and disruption_log only. NEVER present the signal as a measured
// transit count: every summary says "market-implied".
//
// PUSH POLICY: events carry no startsAt and a kind the watch layer doesn't page on — pull-only by
// construction (Marco's get_upcoming_disruptions + /ais/disruptions), per the M4 rule that a
// hedged signal must never page. UKMTO advisories (the official channel) were scoped for v1 but
// ukmto.org is Cloudflare-403 to non-browser clients — deferred, revisit with a proper feed.
//
// Pure derivation + fetch separated (mirrors strike-sources.cjs) so everything below the fetch is
// unit-testable without network.

const GAMMA_SEARCH_URL = 'https://gamma-api.polymarket.com/public-search';

// Chokepoints we derive a signal for. `normalDailyTransits` is the sanity anchor the market bands
// are read against (Hormuz: ~100+ ships/day across all classes in normal times — public figure).
const CHOKEPOINTS = [
  { id: 'hormuz', name: 'Strait of Hormuz', query: 'hormuz', normalDailyTransits: 100 },
];

// Question FAMILIES we know how to read (defensive: anything unrecognized is ignored). Markets on
// a live crisis rotate phrasing week to week — the day this shipped, the "average daily transits"
// cluster had dropped out of search while a "ships this week" cluster carried the signal — so the
// parser must recognize multiple families, never one exact market.
const DAILY_BAND_RE = /between\s+(\d+)\s+and\s+(\d+)\s+average daily transits/i;
const WEEKLY_UNDER_RE = /fewer than\s+(\d+)\s+ships transit .* between/i;
const WEEKLY_BAND_RE = /will\s+(\d+)\s*[-–]\s*(\d+)\s+ships transit .* between/i;
const WEEKLY_OVER_RE = /(\d+)\s+or more ships transit .* between/i;
const NORMAL_BY_RE = /traffic returns to normal by\s+(.+?)\??$/i;

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };

/**
 * Extract the readable market signals for one chokepoint from a gamma public-search response.
 * Returns { dailyBands, weeklyBands, normalBy } — prices are 0..1 last trade prices; dailyBands
 * are "average daily transits" buckets; weeklyBands are "ships this week" buckets (total/week).
 * Pure.
 */
function extractMarkets(searchJson, chokepoint) {
  const dailyBands = [];
  const weeklyByEvent = new Map(); // event title -> bands; separate WEEKS must not pool into one distribution
  let normalBy = null;
  for (const ev of searchJson?.events || []) {
    if (ev?.closed === true) continue;
    const title = String(ev?.title || '');
    if (!title.toLowerCase().includes(chokepoint.query)) continue;
    const wk = () => { if (!weeklyByEvent.has(title)) weeklyByEvent.set(title, []); return weeklyByEvent.get(title); };
    for (const m of ev?.markets || []) {
      if (m?.closed === true) continue;
      const q = String(m?.question || '');
      const price = num(m?.lastTradePrice);
      if (price == null) continue;
      let mt;
      if ((mt = q.match(DAILY_BAND_RE))) { dailyBands.push({ lo: +mt[1], hi: +mt[2], price }); continue; }
      if ((mt = q.match(WEEKLY_UNDER_RE))) { wk().push({ lo: 0, hi: +mt[1], price }); continue; }
      if ((mt = q.match(WEEKLY_BAND_RE))) { wk().push({ lo: +mt[1], hi: +mt[2], price }); continue; }
      if ((mt = q.match(WEEKLY_OVER_RE))) { wk().push({ lo: +mt[1], hi: Math.round(+mt[1] * 1.5), price }); continue; }
      const nb = title.match(NORMAL_BY_RE) || q.match(NORMAL_BY_RE);
      // "returns to normal by X" is a Yes/No market: price = P(back to normal by that date).
      if (nb && normalBy == null) normalBy = { label: nb[1].trim(), price };
    }
  }
  // Pooling bands across different weeks would double-count probability mass (each week's cluster
  // sums to ~1 on its own), so pick ONE weekly event: the one with the most mass (most liquid/
  // complete cluster — in practice the current week).
  let weeklyBands = [];
  let best = 0;
  for (const bands of weeklyByEvent.values()) {
    const mass = bands.reduce((s, b) => s + b.price, 0);
    if (mass > best) { best = mass; weeklyBands = bands; }
  }
  dailyBands.sort((a, b) => a.lo - b.lo);
  weeklyBands.sort((a, b) => a.lo - b.lo);
  return { dailyBands, weeklyBands, normalBy };
}

/**
 * Derive the chokepoint state from extracted markets. Pure.
 *
 * The band cluster is a market-implied probability distribution over average daily transits; we
 * take the dominant band (highest price) as the state anchor and a probability-weighted midpoint
 * as the implied count. Thresholds are relative to the chokepoint's normal flow:
 *   dominant band entirely under 30% of normal -> 'severe'
 *   dominant band entirely under 60% of normal -> 'disrupted'
 *   otherwise                                  -> 'normal'
 * Confidence = the dominant band's price (what the market actually asserts), floored to 2dp.
 * Returns null when there is nothing readable — an absent market must mean "no signal", never
 * "all clear": markets on a chokepoint largely EXIST only while something is wrong.
 */
function deriveSignal(extracted, chokepoint) {
  const { dailyBands, weeklyBands, normalBy } = extracted || {};
  // Prefer the avg-daily family (directly in the unit we reason in); fall back to the weekly family
  // converted to daily (total/7). Both are band distributions, so the logic below is shared.
  let bands = null;
  let basis = null;
  if (dailyBands && dailyBands.length) { bands = dailyBands; basis = 'avg-daily'; }
  else if (weeklyBands && weeklyBands.length) {
    bands = weeklyBands.map((b) => ({ lo: b.lo / 7, hi: b.hi / 7, price: b.price }));
    basis = 'weekly';
  }
  if (!bands) return null;
  const mass = bands.reduce((s, b) => s + b.price, 0);
  if (mass <= 0.05) return null; // dead/illiquid cluster — not a signal
  const implied = Math.round(bands.reduce((s, b) => s + ((b.lo + b.hi) / 2) * b.price, 0) / mass);
  const dominant = bands.reduce((a, b) => (b.price > a.price ? b : a));
  const normal = chokepoint.normalDailyTransits;
  let state = 'normal';
  if (dominant.hi <= 0.3 * normal) state = 'severe';
  else if (dominant.hi <= 0.6 * normal) state = 'disrupted';
  return {
    chokepointId: chokepoint.id,
    state,
    basis,
    confidence: Math.floor(dominant.price * 100) / 100, // floor: 0.995 shows as 0.99, never a claimed certainty of 1
    impliedDailyTransits: implied,
    dominantBand: { lo: Math.round(dominant.lo), hi: Math.round(dominant.hi), price: dominant.price },
    normalBy: normalBy || null,
    bands,
  };
}

/**
 * Build disruption events from a signal. Pure. Empty for 'normal' (no event = no noise). The event
 * shape matches strike-sources events so mergeDisruptionEvents/serving need no changes:
 * no `country` (stays out of ?country=/?port= filters — pull-only, unfiltered feed + Marco), no
 * `startsAt` (never enters the watch push window). Id is stable per (chokepoint, state) so
 * disruption_log's first-seen records each ESCALATION once (severe and disrupted are separate rows).
 */
function buildChokepointEvents(signal, chokepoint, now = Date.now()) {
  if (!signal || signal.state === 'normal') return [];
  const pctNormalBy = signal.normalBy ? Math.round(signal.normalBy.price * 100) : null;
  const summary = `Market-implied: ${chokepoint.name} transit flow ${signal.state === 'severe' ? 'severely disrupted' : 'disrupted'} — `
    + `public prediction markets imply ~${signal.impliedDailyTransits} transits/day vs ~${chokepoint.normalDailyTransits} normal`
    + (pctNormalBy != null ? `; recovery by ${signal.normalBy.label} priced at ${pctNormalBy}%` : '')
    + '. Not a measured count.';
  return [{
    id: `market:${chokepoint.id}:${signal.state}`,
    country: null,
    kind: 'chokepoint_disruption',
    summary,
    source: 'market-implied',
    confidence: signal.confidence,
    startsAt: null,
    endsAt: null,
    chokepoint: chokepoint.id,
    observedAt: now,
  }];
}

/**
 * Fetch + derive for all chokepoints. Network edge — everything else is pure. Best-effort per
 * chokepoint; a failed fetch yields no events (absence of signal, never "all clear"). Logs
 * provenance (exact market questions + prices) relay-side only — the served events stay generic.
 */
async function fetchChokepointEvents(fetchImpl = fetch, now = Date.now()) {
  const events = [];
  for (const cp of CHOKEPOINTS) {
    try {
      const res = await fetchImpl(`${GAMMA_SEARCH_URL}?q=${encodeURIComponent(cp.query)}`, {
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const extracted = extractMarkets(await res.json(), cp);
      const signal = deriveSignal(extracted, cp);
      if (signal) {
        const prov = [...extracted.dailyBands.map((b) => `d${b.lo}-${b.hi}@${b.price}`),
          ...extracted.weeklyBands.map((b) => `w${b.lo}-${b.hi}@${b.price}`)].join(' ');
        console.log(`[Relay] chokepoint ${cp.id}: state=${signal.state} basis=${signal.basis} implied=${signal.impliedDailyTransits}/day conf=${signal.confidence}`
          + ` | provenance: ${prov}${extracted.normalBy ? ` normalBy@${extracted.normalBy.price}` : ''}`);
        events.push(...buildChokepointEvents(signal, cp, now));
      } else {
        console.log(`[Relay] chokepoint ${cp.id}: no readable market signal`);
      }
    } catch (e) {
      console.warn(`[Relay] chokepoint ${cp.id} market fetch failed:`, e.message);
    }
  }
  return events;
}

module.exports = { CHOKEPOINTS, extractMarkets, deriveSignal, buildChokepointEvents, fetchChokepointEvents };
