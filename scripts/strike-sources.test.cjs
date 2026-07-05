'use strict';

const { test } = require('node:test');
const { strict: assert } = require('node:assert');
const { parseMitStrikeRss, mergeDisruptionEvents, strikeReasonForPort } = require('./strike-sources.cjs');

// Real item shape from the live feed (2026-07-05), sector swapped to the port-relevant case.
const MIT_SAMPLE = `<?xml version="1.0"?><rss><channel>
<item>
  <title>Data inizio: 12/07/2026 - Settore: Marittimo - Rilevanza: Territoriale - Regione:  Liguria - Provincia: Genova</title>
  <description><![CDATA[modalità: 24 ORE<br/>Data fine: 12/07/2026<br/>Settore: Marittimo<br/>Rilevanza: Territoriale<br/>Regione:  Liguria<br/>Provincia: Genova<br/>Sindacati: FILT CGIL<br/>Categoria interessata: PERSONALE MARITTIMO<br/>Data proclamazione: 20/06/2026]]></description>
  <pubDate>Sat, 04 Jul 2026 22:00:00 +0000</pubDate>
  <guid>http://scioperi.mit.gov.it/9001</guid>
</item>
<item>
  <title>Data inizio: 05/07/2026 - Settore: Aereo - Rilevanza: Nazionale - Regione:  Italia - Provincia: Tutte</title>
  <description><![CDATA[modalità: 24 ORE<br/>Data fine: 05/07/2026<br/>Settore: Aereo<br/>Sindacati: CUB]]></description>
  <guid>http://scioperi.mit.gov.it/9002</guid>
</item>
</channel></rss>`;

test('parseMitStrikeRss: structured fields, advance startsAt, port-relevance flag', () => {
  const events = parseMitStrikeRss(MIT_SAMPLE);
  assert.equal(events.length, 2);
  const [maritime, air] = events;
  assert.equal(maritime.kind, 'strike_scheduled');
  assert.equal(maritime.source, 'mit-scioperi');
  assert.equal(new Date(maritime.startsAt).toISOString().slice(0, 10), '2026-07-12');
  assert.equal(maritime.region, 'Liguria');
  assert.equal(maritime.national, false);
  assert.equal(maritime.portRelevant, true);   // Marittimo
  assert.equal(air.portRelevant, false);       // Aereo doesn't touch port flow
  assert.match(maritime.summary, /Marittimo.*Liguria.*FILT CGIL/);
});

test('mergeDisruptionEvents: dedupes by id (higher confidence wins), scheduled-with-date sorts first', () => {
  const merged = mergeDisruptionEvents([
    [{ id: 'a', kind: 'strike_report', confidence: 0.4, summary: 'x', country: 'NL' }],
    [{ id: 'a', kind: 'strike_report', confidence: 0.45, summary: 'x better', country: 'NL' },
     { id: 'b', kind: 'strike_scheduled', confidence: 0.9, summary: 'sched', country: 'IT', startsAt: 5 }],
  ]);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].id, 'b'); // dated first
  assert.equal(merged[1].summary, 'x better');
});

const NOW = Date.UTC(2026, 6, 5, 12); // 2026-07-05T12:00Z

test('strikeReasonForPort: scheduled regional strike hits its region within lookahead, not elsewhere', () => {
  const events = parseMitStrikeRss(MIT_SAMPLE); // Liguria strike on Jul 12 (7d ahead of NOW)
  const genoa = strikeReasonForPort(events, { country: 'IT', region: 'Liguria', portName: 'Genoa' }, NOW);
  assert.ok(genoa, 'Liguria strike should reach a Ligurian port');
  assert.match(genoa.summary, /starts 2026-07-12/);
  assert.equal(genoa.startsAt, Date.UTC(2026, 6, 12));
  assert.equal(strikeReasonForPort(events, { country: 'IT', region: 'Sicilia', portName: 'Palermo' }, NOW), null);
  assert.equal(strikeReasonForPort(events, { country: 'NL', region: 'South Holland', portName: 'Rotterdam' }, NOW), null);
});

test('strikeReasonForPort: national scheduled strike reaches every port in the country', () => {
  const ev = [{ id: 'n', country: 'IT', kind: 'strike_scheduled', source: 'mit-scioperi', confidence: 0.9, summary: 'Scheduled general strike (national)', national: true, startsAt: NOW + 24 * 3_600_000, endsAt: NOW + 24 * 3_600_000 }];
  assert.ok(strikeReasonForPort(ev, { country: 'IT', region: 'Sicilia', portName: 'Palermo' }, NOW));
});

test('strikeReasonForPort: reports only attach when the headline names the port or region', () => {
  const ev = [{ id: 'r', country: 'NL', kind: 'strike_report', source: 'union-news', confidence: 0.45, summary: 'FNV kondigt staking aan in haven Rotterdam' }];
  assert.ok(strikeReasonForPort(ev, { country: 'NL', region: 'South Holland', portName: 'Rotterdam' }, NOW));
  assert.equal(strikeReasonForPort(ev, { country: 'NL', region: 'North Holland', portName: 'Amsterdam' }, NOW), null);
});

test('strikeReasonForPort: expired scheduled strike goes quiet', () => {
  const ev = [{ id: 'old', country: 'IT', kind: 'strike_scheduled', source: 'mit-scioperi', confidence: 0.9, summary: 'old', national: true, startsAt: NOW - 5 * 24 * 3_600_000, endsAt: NOW - 3 * 24 * 3_600_000 }];
  assert.equal(strikeReasonForPort(ev, { country: 'IT', region: 'Liguria', portName: 'Genoa' }, NOW), null);
});
