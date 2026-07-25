'use strict';

// PARITY GUARD — the source-side sibling of assistant/coverage.test.mjs (which guards the PROSE).
// Every country with a commercial port in src/config/italy-ferries.data.json must have a COMPLETE
// country-sources entry, and every commercial port must resolve to ≥1 weather-alert area keyword.
// So "launch a new country" = add ports → THIS fails CI, listing exactly which sources are missing
// → parity by construction, never by memory.

const { test } = require('node:test');
const { strict: assert } = require('node:assert');
const { COUNTRY_SOURCES, sourcesFor, alertAreaKeywordsFor, disruptionVocabularyFor, foldText } = require('./country-sources.cjs');
const { COUNTRY_TZ } = require('./db.cjs');
const { GDELT_COUNTRY } = require('./strike-sources.cjs');

const { ports } = require('../src/config/italy-ferries.data.json');
const commercial = ports.filter((p) => p.commercial);
const countries = [...new Set(commercial.map((p) => p.country))];

test('every port declares its country explicitly (no implicit-Italy null)', () => {
  // Italy used to be the absent value: Italian rows carried no `country`, so ~12 call sites spelled
  // `p.country || 'IT'` and any new reader that forgot the fallback silently got undefined and a
  // missed lookup. Every row now says which country it is, so the fallback is dead code, not load-bearing.
  for (const p of ports) {
    assert.match(String(p.country || ''), /^[A-Z]{2}$/,
      `port "${p.id}" has no explicit "country" — add the ISO-3166 alpha-2 code to the port row. ` +
        `Italy is not the default any more.`);
  }
});

test('every covered country has a COMPLETE source entry (news, vocabulary, alert feed)', () => {
  for (const code of countries) {
    const src = COUNTRY_SOURCES[code];
    assert.ok(src, `country "${code}" has commercial ports but NO country-sources entry — add one (news locale, strike/disruption terms, meteoalarm feed, alert-area keywords) before launching`);
    assert.ok(src.name, `${code}: missing display name`);
    for (const f of ['hl', 'gl', 'ceid', 'freightNoun']) {
      assert.ok(src.news && src.news[f], `${code}: news locale missing "${f}" — local press is where disruptions surface`);
    }
    assert.ok(Array.isArray(src.strikeTerms) && src.strikeTerms.length >= 2, `${code}: needs strike terms (English + local language)`);
    assert.ok(Array.isArray(src.disruptionTerms) && src.disruptionTerms.length >= 5, `${code}: needs disruption terms (English + local language)`);
    assert.match(String(src.meteoalarmFeed || ''), /^https:\/\//, `${code}: needs an official weather-alert feed URL (meteoalarm or national CAP equivalent)`);
    // M3: every country needs the curated union layer (the official calendar is IT-only bonus).
    assert.ok(src.strikeSources && Array.isArray(src.strikeSources.unions) && src.strikeSources.unions.length >= 1,
      `${code}: needs strikeSources.unions (≥1 curated union/entity for the strike-news layer)`);
    // Baselines bucket in the port's LOCAL tz — without an entry here tzForCountry silently
    // falls back to Europe/Rome and the country's congestion baselines are bucketed wrong.
    assert.ok(COUNTRY_TZ[code],
      `${code}: missing db.cjs COUNTRY_TZ entry — congestion baselines would silently bucket in Europe/Rome`);
    // Every registered country must map to a GDELT sourcecountry, else fetchGdeltStrikes short-circuits
    // to [] and that country silently loses GDELT strike coverage (the gap that dropped PT).
    assert.ok(GDELT_COUNTRY[code],
      `${code}: missing strike-sources.cjs GDELT_COUNTRY entry — GDELT strike reports would silently never fetch`);
  }
});

test('every commercial port resolves to ≥1 alert-area keyword (else official warnings can never match it)', () => {
  for (const p of commercial) {
    const kw = alertAreaKeywordsFor({ id: p.id, country: p.country, region: p.region });
    assert.ok(kw.length >= 1,
      `port "${p.id}" (${p.country}, region "${p.region}") maps to NO alert-area keywords — ` +
      'add its region to alertAreaKeywordsByRegion or a per-port override in alertAreaKeywordsByPort');
    for (const k of kw) assert.equal(k, foldText(k), `keyword "${k}" for ${p.id} must be pre-folded (lowercase, accent-free)`);
  }
});

test('vocabulary + folding helpers behave', () => {
  assert.equal(foldText('Cádiz — SCIOPERO'), 'cadiz — sciopero');
  assert.ok(disruptionVocabularyFor('NL').strikeTerms.includes('staking'));
  assert.ok(disruptionVocabularyFor('ES').strikeTerms.includes('huelga'));
  // No country is no longer a synonym for Italy — an unknown code degrades to the shared English
  // vocabulary, not to Italian, so a future country can never inherit Italy's terms by accident.
  assert.ok(!disruptionVocabularyFor(undefined).strikeTerms.includes('sciopero'));
  assert.ok(disruptionVocabularyFor(undefined).strikeTerms.includes('strike'));
  assert.equal(sourcesFor(undefined), null);
  assert.equal(sourcesFor('XX'), null);
});

// --- SENSING parity (the gap that shipped the Lisboa "congestion clear" bug) -------------------
// The tests above check that a country is DECLARED everywhere — news locale, vocabulary, alert
// feed, timezone. None of them asked whether any AIS feed can physically SEE it. aisstream is
// global, but the only tile-polled fallback covers ITALY_BBOX, so every non-Italian port goes dark
// with aisstream and nothing failed CI to say so. These tests make the fallback's geometry a
// registry obligation: declare it, and the declaration must match where the tiles actually are.
const { ITALY_TILES, tileIndexFor } = require('./marinesia.cjs');

const FALLBACK_TILES = { marinesia: ITALY_TILES };
const inFallback = (feed, p) => tileIndexFor(FALLBACK_TILES[feed], p.lat, p.lon) >= 0;

test('every covered country DECLARES its AIS fallback (null is allowed, undefined is not)', () => {
  for (const code of countries) {
    const src = COUNTRY_SOURCES[code];
    assert.ok(
      Object.hasOwn(src, 'aisFallback'),
      `${code}: no "aisFallback" declaration. Say which tile-polled feed still sees this country's ` +
        `ports when aisstream is dark, or null if none does — a country cannot ship without an ` +
        `explicit answer, because null silently reads as "clear" to users.`,
    );
    assert.ok(
      src.aisFallback === null || Object.hasOwn(FALLBACK_TILES, src.aisFallback),
      `${code}: aisFallback "${src.aisFallback}" is not a known tile-polled feed (${Object.keys(FALLBACK_TILES).join(', ')}). ` +
        `Add its tile grid to FALLBACK_TILES here when you add the feed.`,
    );
  }
});

test('a declared AIS fallback actually covers that country\'s ports', () => {
  for (const p of commercial) {
    const code = p.country;
    const feed = COUNTRY_SOURCES[code].aisFallback;
    if (feed === null) continue;
    assert.ok(
      inFallback(feed, p),
      `${p.id} (${code}) claims aisFallback "${feed}", but its coordinates (${p.lat}, ${p.lon}) fall ` +
        `outside that feed's tile grid — the claim is false and the port would report stale counts ` +
        `as live. Extend the grid, or declare aisFallback: null for ${code}.`,
    );
  }
});

test('a null AIS fallback is not hiding coverage the tiles already provide', () => {
  // The mirror case: under-declaring is as wrong as over-declaring — it would have us caveat a
  // port we can actually see. Catches a country added inside ITALY_BBOX with a copy-pasted null.
  for (const p of commercial) {
    const code = p.country;
    if (COUNTRY_SOURCES[code].aisFallback !== null) continue;
    for (const feed of Object.keys(FALLBACK_TILES)) {
      assert.ok(
        !inFallback(feed, p),
        `${p.id} (${code}) declares aisFallback: null, but it sits INSIDE the "${feed}" tile grid — ` +
          `it does have fallback coverage. Declare aisFallback: "${feed}" for ${code}.`,
      );
    }
  }
});
