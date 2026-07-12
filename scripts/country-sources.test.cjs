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

const { ports } = require('../src/config/italy-ferries.data.json');
const commercial = ports.filter((p) => p.commercial);
const countries = [...new Set(commercial.map((p) => p.country || 'IT'))];

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
  }
});

test('every commercial port resolves to ≥1 alert-area keyword (else official warnings can never match it)', () => {
  for (const p of commercial) {
    const kw = alertAreaKeywordsFor({ id: p.id, country: p.country || 'IT', region: p.region });
    assert.ok(kw.length >= 1,
      `port "${p.id}" (${p.country || 'IT'}, region "${p.region}") maps to NO alert-area keywords — ` +
      'add its region to alertAreaKeywordsByRegion or a per-port override in alertAreaKeywordsByPort');
    for (const k of kw) assert.equal(k, foldText(k), `keyword "${k}" for ${p.id} must be pre-folded (lowercase, accent-free)`);
  }
});

test('vocabulary + folding helpers behave', () => {
  assert.equal(foldText('Cádiz — SCIOPERO'), 'cadiz — sciopero');
  assert.ok(disruptionVocabularyFor('NL').strikeTerms.includes('staking'));
  assert.ok(disruptionVocabularyFor('ES').strikeTerms.includes('huelga'));
  assert.ok(disruptionVocabularyFor(undefined).strikeTerms.includes('sciopero')); // no country field = Italy
  assert.equal(sourcesFor('XX'), null);
});
