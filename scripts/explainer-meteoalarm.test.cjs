'use strict';

const { test } = require('node:test');
const { strict: assert } = require('node:assert');

const { parseMeteoalarmFeed, matchMeteoalarm } = require('./explainer-meteoalarm.cjs');

// Minimal ATOM/CAP sample mirroring the real Meteoalarm Italy feed shape.
const SAMPLE = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:cap="urn:oasis:names:tc:emergency:cap:1.2">
  <entry>
    <cap:areaDesc>Sardegna</cap:areaDesc>
    <cap:event>Orange Coastal Event Warning</cap:event>
    <cap:onset>2026-06-21T00:00:00+00:00</cap:onset>
    <cap:expires>2026-06-21T18:00:00+00:00</cap:expires>
    <cap:severity>Severe</cap:severity>
    <title>Orange Coastal Event Warning issued for Italy - Sardegna</title>
  </entry>
  <entry>
    <cap:areaDesc>Sicilia</cap:areaDesc>
    <cap:event>Yellow High-temperature Warning</cap:event>
    <cap:onset>2026-06-21T06:00:00+00:00</cap:onset>
    <cap:expires>2026-06-21T18:00:00+00:00</cap:expires>
    <cap:severity>Moderate</cap:severity>
    <title>Yellow High-temperature Warning issued for Italy - Sicilia</title>
  </entry>
</feed>`;

const NOON = Date.parse('2026-06-21T12:00:00Z');

test('parses entries into region/event/color/type/onset/expires', () => {
  const w = parseMeteoalarmFeed(SAMPLE);
  assert.equal(w.length, 2);
  const sard = w.find((x) => x.region === 'Sardegna');
  assert.ok(sard);
  assert.equal(sard.color, 'orange');
  assert.match(sard.awarenessType, /coastal/i);
  assert.ok(Number.isFinite(sard.onset) && Number.isFinite(sard.expires));
});

test('matches an active marine warning for the destination region', () => {
  const warnings = parseMeteoalarmFeed(SAMPLE);
  const r = matchMeteoalarm(warnings, { destRegion: 'Sardegna' }, NOON);
  assert.ok(r);
  assert.equal(r.source, 'meteoalarm');
  assert.equal(r.kind, 'marine_warning');
  assert.match(r.summary, /Sardegna/);
  assert.match(r.summary, /coastal/i);
  assert.ok(r.confidence >= 0.6); // orange
});

test('does not match a non-marine warning (high-temperature)', () => {
  const warnings = parseMeteoalarmFeed(SAMPLE);
  // Sicilia only has a heat warning -> no marine match.
  assert.equal(matchMeteoalarm(warnings, { destRegion: 'Sicilia' }, NOON), null);
});

test('does not match a different region', () => {
  const warnings = parseMeteoalarmFeed(SAMPLE);
  assert.equal(matchMeteoalarm(warnings, { destRegion: 'Campania' }, NOON), null);
});

test('does not match outside the warning validity window', () => {
  const warnings = parseMeteoalarmFeed(SAMPLE);
  const tooLate = Date.parse('2026-06-22T00:00:00Z'); // after Sardegna expires
  assert.equal(matchMeteoalarm(warnings, { destRegion: 'Sardegna' }, tooLate), null);
});

test('returns null without a destination region', () => {
  const warnings = parseMeteoalarmFeed(SAMPLE);
  assert.equal(matchMeteoalarm(warnings, {}, NOON), null);
});

test('picks the most severe when multiple active warnings overlap', () => {
  const xml = SAMPLE.replace(
    '<title>Yellow High-temperature Warning issued for Italy - Sicilia</title>',
    '<title>x</title>',
  ).replace('Sicilia', 'Sardegna').replace('Yellow High-temperature', 'Red Wind');
  const r = matchMeteoalarm(parseMeteoalarmFeed(xml), { destRegion: 'Sardegna' }, NOON);
  assert.ok(r && r.confidence >= 0.85); // red wins over orange
  assert.match(r.summary, /red/i);
});
