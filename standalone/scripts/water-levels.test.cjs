'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const {
  RHINE_GAUGES, MOSE_ACTIVATION_CM,
  classifyRhineLevel, buildRhineEvents, parseVeniceMeters, buildVeniceEvents,
  parseAcpAdvisories, buildAcpEvents, fetchWaterLevelEvents,
} = require('./water-levels.cjs');

const KAUB = RHINE_GAUGES.find((g) => g.id === 'kaub');

// --- Rhine ---------------------------------------------------------------------------------

test('classifyRhineLevel: marks are inclusive at the boundary', () => {
  assert.strictEqual(classifyRhineLevel(200, KAUB), 'normal');
  assert.strictEqual(classifyRhineLevel(150, KAUB), 'low');      // surcharge mark
  assert.strictEqual(classifyRhineLevel(79, KAUB), 'low');
  assert.strictEqual(classifyRhineLevel(78, KAUB), 'critical');  // GlW line
  assert.strictEqual(classifyRhineLevel(45, KAUB), 'critical');  // July 2026 episode bottom
  assert.strictEqual(classifyRhineLevel(null, KAUB), null);
});

test('buildRhineEvents: normal water emits nothing', () => {
  assert.deepStrictEqual(buildRhineEvents({ cm: 220, trendCm: 0 }, KAUB), []);
});

test('buildRhineEvents: low state — stable id, hinterland ports, surcharge mark in summary', () => {
  const [e] = buildRhineEvents({ cm: 80, trendCm: 35 }, KAUB, 1000);
  assert.strictEqual(e.id, 'water:kaub:low');
  assert.strictEqual(e.kind, 'waterway_low_water');
  assert.strictEqual(e.startsAt, null); // pull-only by construction
  assert.strictEqual(e.country, null);
  assert.deepStrictEqual(e.ports, ['rotterdam', 'moerdijk', 'amsterdam', 'vlissingen']);
  assert.match(e.summary, /80 cm/);
  assert.match(e.summary, /150 cm/);
  assert.match(e.summary, /rising \(\+35 cm/);
});

test('buildRhineEvents: critical state gets its own id (escalation logs first-seen separately)', () => {
  const [e] = buildRhineEvents({ cm: 45, trendCm: -12 }, KAUB, 1000);
  assert.strictEqual(e.id, 'water:kaub:critical');
  assert.match(e.summary, /GlW/);
  assert.match(e.summary, /falling \(-12 cm/);
});

test('buildRhineEvents: trend near zero reads steady, missing trend says nothing', () => {
  assert.match(buildRhineEvents({ cm: 100, trendCm: 2 }, KAUB)[0].summary, /steady/);
  assert.doesNotMatch(buildRhineEvents({ cm: 100, trendCm: null }, KAUB)[0].summary, /steady|rising|falling/);
});

// --- Venice --------------------------------------------------------------------------------

test('parseVeniceMeters: live feed shape "0.59 m" → 59 cm', () => {
  assert.strictEqual(parseVeniceMeters('0.59 m'), 59);
  assert.strictEqual(parseVeniceMeters('1.10 m'), 110);
  assert.strictEqual(parseVeniceMeters('n/a'), null);
});

// Fixture mirrors the live previsione.json shape (captured 2026-07-19).
const forecastRows = (maxVal) => [
  { DATA_PREVISIONE: '2026-07-18 13:30:00', DATA_ESTREMALE: '2026-07-18 14:45:00', TIPO_ESTREMALE: 'max', VALORE: String(maxVal) },
  { DATA_PREVISIONE: '2026-07-18 13:30:00', DATA_ESTREMALE: '2026-07-18 20:45:00', TIPO_ESTREMALE: 'min', VALORE: '25.0' },
];

test('buildVeniceEvents: quiet forecast and quiet live → no events', () => {
  assert.deepStrictEqual(buildVeniceEvents(59, forecastRows(80)), []);
});

test('buildVeniceEvents: forecast max at the MOSE mark → water_closure keyed on the extreme date', () => {
  const events = buildVeniceEvents(59, forecastRows(MOSE_ACTIVATION_CM), 1000);
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].id, 'water:venice:mose:2026-07-18');
  assert.strictEqual(events[0].kind, 'water_closure');
  assert.deepStrictEqual(events[0].ports, ['venezia', 'porto_marghera']);
  assert.match(events[0].summary, /forecast high tide/);
});

test('buildVeniceEvents: a min extreme above the mark is not a closure (only maxima count)', () => {
  const rows = [{ DATA_ESTREMALE: '2026-07-18 20:45:00', TIPO_ESTREMALE: 'min', VALORE: '120' }];
  assert.deepStrictEqual(buildVeniceEvents(50, rows), []);
});

test('buildVeniceEvents: live tide above the mark emits, and merges with a same-day forecast', () => {
  const now = Date.parse('2026-07-18T15:00:00Z');
  const live = buildVeniceEvents(115, [], now);
  assert.strictEqual(live.length, 1);
  assert.match(live[0].summary, /live tide/);
  const merged = buildVeniceEvents(115, forecastRows(112), now);
  assert.strictEqual(merged.length, 1); // same closure date collapses to one event
});

// --- Panama --------------------------------------------------------------------------------

// Href shapes captured from the live listing 2026-07-19 (incl. the 2-digit-year variant and a
// repeated entry; booking-system advisories are the noise family).
const ACP_HTML = `
<a href="/wp-content/uploads/ADV-22-2026-Draft-adjustment-in-the-Neopanamax-Locks.pdf">View advisory</a>
<a href="/wp-content/uploads/ADV-22-2026-Draft-adjustment-in-the-Neopanamax-Locks.pdf">View advisory</a>
<a href="/wp-content/uploads/ADV-21-2026-Scheduled-Lane-Outage-at-Gatun-Locks-and-Modifications-to-the-Transit-Reservation.pdf">View advisory</a>
<a href="/wp-content/uploads/ADV-15-26-JUNE-EAST-DRY-CHAMBER-.pdf">View advisory</a>
<a href="/wp-content/uploads/ADV-13-2026-Modifications-to-the-Transit-Reservation-Booking-System.pdf">View advisory</a>
<a href="/wp-content/uploads/ADV-33-2025-LoTSA-2.0-Clarification.pdf">View advisory</a>
<a href="/wp-content/uploads/ADV-11-2025-Scheduled-Culvert-maintenance-at-Gatun-Locks.pdf">View advisory</a>
`;

test('parseAcpAdvisories: extracts, dedupes, classifies, absolutizes urls, ignores booking noise', () => {
  const advs = parseAcpAdvisories(ACP_HTML);
  const ids = advs.map((a) => a.advId).sort();
  assert.deepStrictEqual(ids, ['ADV-11-2025', 'ADV-15-2026', 'ADV-21-2026', 'ADV-22-2026']);
  const draft = advs.find((a) => a.advId === 'ADV-22-2026');
  assert.strictEqual(draft.kind, 'draft_restriction');
  assert.match(draft.url, /^https:\/\/pancanal\.com\//);
  assert.strictEqual(advs.find((a) => a.advId === 'ADV-21-2026').kind, 'water_closure');
  assert.strictEqual(advs.find((a) => a.advId === 'ADV-15-2026').kind, 'water_closure'); // dry chamber, 2-digit year
});

test('buildAcpEvents: current year only, official confidence, no startsAt in v1', () => {
  const events = buildAcpEvents(parseAcpAdvisories(ACP_HTML), 1000, 2026);
  const ids = events.map((e) => e.id).sort();
  assert.deepStrictEqual(ids, ['acp:ADV-15-2026', 'acp:ADV-21-2026', 'acp:ADV-22-2026']); // 2025 rows are history
  const draft = events.find((e) => e.id === 'acp:ADV-22-2026');
  assert.strictEqual(draft.kind, 'draft_restriction');
  assert.strictEqual(draft.confidence, 0.9);
  assert.strictEqual(draft.startsAt, null);
  assert.match(draft.summary, /Draft adjustment in the Neopanamax Locks/);
});

// --- aggregate resilience ------------------------------------------------------------------

test('fetchWaterLevelEvents: one source down never blanks the others', async () => {
  const fetchImpl = async (url) => {
    if (/pegelonline/.test(url)) throw new Error('boom');
    if (/livello/.test(url)) return { ok: true, json: async () => [{ stazione: 'Punta Salute Canal Grande', valore: '1.20 m' }] };
    if (/previsione/.test(url)) return { ok: true, json: async () => [] };
    if (/pancanal/.test(url)) return { ok: true, text: async () => ACP_HTML };
    throw new Error(`unexpected url ${url}`);
  };
  const events = await fetchWaterLevelEvents(fetchImpl, Date.parse('2026-07-19T12:00:00Z'));
  const kinds = events.map((e) => e.kind).sort();
  assert.deepStrictEqual(kinds, ['draft_restriction', 'water_closure', 'water_closure', 'water_closure']);
  assert.ok(events.some((e) => e.id.startsWith('water:venice:mose:')));
});
