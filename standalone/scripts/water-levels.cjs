'use strict';

// M5 v1 — water-level disruption sources (scope: assistant/DISRUPTION_SOURCES_SCOPE.md, PR #112).
//
// WHY WATER LEVELS: the gauge is a LEADING indicator port-level AIS cannot see. During the July
// 2026 Rhine episode (Kaub 45 cm, barges at ~20% load, Rotterdam-Karlsruhe freight +40%) our own
// Rotterdam/Moerdijk entries + dwell stayed FLAT for 14 days — payloads halve but hulls keep
// moving. Three mechanisms, three kinds:
//   waterway_low_water — corridor economics degrade (Rhine → NL hinterland ports)
//   water_closure     — direct blockage / capacity cut (Venice MOSE; Panama lock outages)
//   draft_restriction — announced draft cuts (Panama Neopanamax advisories)
//
// SOURCES (all official, all verified live 2026-07-19):
//   PEGELONLINE (DE WSV, free, keyless JSON) — Kaub is THE commercial reference the surcharge
//     scales key off; never substitute a model proxy. BfG/ELWIS forecast layer DEFERRED: no
//     machine-readable feed exists (HTML only, verified at build per scope).
//   dati.venezia.it (free JSON) — live tide (Punta Salute) + published forecast extremes; a
//     forecast ≥ the MOSE activation mark means the lagoon (and port entrances) likely closes.
//   pancanal.com advisories (official, HTML) — advisory ids + titles are in the PDF filenames;
//     effective dates live INSIDE the PDFs, so v1 events carry no startsAt (the advisory id is
//     the calendar signal; date parsing is a v2 concern).
//
// PUSH POLICY: pull-only by construction — no `startsAt` and kinds the watch layer doesn't page
// on (pushes filter kind === 'strike_scheduled', assistant/watches.mjs). Scope open question 4
// (do official gauge transitions page like strike calendars?) stays open until a shakedown week.
//
// Pure derivation separated from fetch (mirrors strike-sources.cjs / chokepoint-markets.cjs).

const PEGELONLINE_BASE = 'https://www.pegelonline.wsv.de/webservices/rest-api/v2';
const VENICE_LEVEL_URL = 'https://dati.venezia.it/sites/default/files/dataset/opendata/livello.json';
const VENICE_FORECAST_URL = 'https://dati.venezia.it/sites/default/files/dataset/opendata/previsione.json';
const ACP_ADVISORIES_URL = 'https://pancanal.com/en/advisories-to-shipping/';

// MOSE barriers are activated for forecast tides ≥ ~110 cm (official operating threshold);
// while the barriers are up, the lagoon inlets — and therefore the port entrances — are shut.
const MOSE_ACTIVATION_CM = 110;

// Commercial marks at Kaub: GlW 2021 = 78 cm is the contract low-water reference (loading
// collapses below it — the live July 2026 episode bottomed at 45 cm with ~20% barge loads);
// low-water surcharge scales in COA contracts typically arm from ~150 cm down.
const RHINE_GAUGES = [
  {
    id: 'kaub',
    station: 'KAUB',
    name: 'Rhine at Kaub',
    lowCm: 150,
    criticalCm: 78,
    hinterlandPorts: ['rotterdam', 'moerdijk', 'amsterdam', 'vlissingen'],
  },
];

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };

/** normal / low / critical off the gauge's documented marks. Pure. */
function classifyRhineLevel(cm, gauge) {
  if (cm == null) return null;
  if (cm <= gauge.criticalCm) return 'critical';
  if (cm <= gauge.lowCm) return 'low';
  return 'normal';
}

/**
 * Rhine gauge reading → 0..1 waterway_low_water events. Id is stable per (gauge, state) so
 * disruption_log first-seen records each escalation once (same pattern as chokepoint events).
 * `trendCm` is (latest - 3 days ago), best-effort null. Pure.
 */
function buildRhineEvents(reading, gauge, now = Date.now()) {
  const state = classifyRhineLevel(reading?.cm, gauge);
  if (!state || state === 'normal') return [];
  const trend = reading.trendCm == null ? ''
    : reading.trendCm > 5 ? ` — rising (+${Math.round(reading.trendCm)} cm over 3 days)`
    : reading.trendCm < -5 ? ` — falling (${Math.round(reading.trendCm)} cm over 3 days)`
    : ' — steady over 3 days';
  const summary = state === 'critical'
    ? `Rhine low water: ${gauge.name} at ${Math.round(reading.cm)} cm, below the ${gauge.criticalCm} cm GlW contract line${trend}. Barge payloads to the ${gauge.hinterlandPorts.join('/')} hinterland severely reduced; expect low-water surcharges and volume shifting to rail/road.`
    : `Rhine low water: ${gauge.name} at ${Math.round(reading.cm)} cm, below the ${gauge.lowCm} cm surcharge mark (GlW line: ${gauge.criticalCm} cm)${trend}. Barge payloads to the ${gauge.hinterlandPorts.join('/')} hinterland reduced.`;
  return [{
    id: `water:${gauge.id}:${state}`,
    country: null,
    kind: 'waterway_low_water',
    summary,
    source: 'pegelonline',
    confidence: 0.9,
    startsAt: null,
    endsAt: null,
    waterway: 'rhine',
    gauge: gauge.id,
    levelCm: reading.cm,
    ports: gauge.hinterlandPorts,
    observedAt: now,
  }];
}

/** '0.59 m' → 59 (cm). Pure. */
function parseVeniceMeters(v) {
  const m = num(String(v ?? '').replace(/\s*m\s*$/i, ''));
  return m == null ? null : Math.round(m * 100);
}

/**
 * Venice live level + forecast extremes → 0..N water_closure events, one per forecast maximum
 * at/above the MOSE activation mark (plus one for a live reading above it). Ids keyed on the
 * extreme's date so each predicted closure window logs first-seen once. Pure.
 */
function buildVeniceEvents(liveCm, forecastRows, now = Date.now()) {
  const events = [];
  const mk = (cm, when, phrasing) => ({
    id: `water:venice:mose:${when.slice(0, 10)}`,
    country: null,
    kind: 'water_closure',
    summary: `Venice lagoon: ${phrasing} ${cm} cm ≥ the ${MOSE_ACTIVATION_CM} cm MOSE activation mark (${when}) — barrier closure likely, port entrances (Venezia/Porto Marghera) shut while barriers are up.`,
    source: 'dati-venezia',
    confidence: 0.9,
    startsAt: null,
    endsAt: null,
    waterway: 'venice_lagoon',
    levelCm: cm,
    ports: ['venezia', 'porto_marghera'],
    observedAt: now,
  });
  for (const row of forecastRows || []) {
    if (row?.TIPO_ESTREMALE !== 'max') continue;
    const cm = num(row.VALORE);
    const when = String(row.DATA_ESTREMALE || '');
    if (cm != null && cm >= MOSE_ACTIVATION_CM && when) events.push(mk(Math.round(cm), when, 'forecast high tide'));
  }
  if (liveCm != null && liveCm >= MOSE_ACTIVATION_CM) {
    events.push(mk(liveCm, new Date(now).toISOString(), 'live tide'));
  }
  // One event per closure date — a live reading during a forecast window collapses into it.
  const byId = new Map(events.map((e) => [e.id, e]));
  return [...byId.values()];
}

// Advisory PDFs are named ADV-<n>-<year>-<slug>.pdf (year sometimes 2-digit). The listing page
// repeats entries; ids dedupe downstream. Booking-system/administrative advisories are noise.
const ACP_PDF_RE = /href="([^"]*\/ADV-?(\d{1,2})-?(\d{2,4})[^"]*?\.pdf)"/gi;

/** Extract advisories from the ACP listing HTML → [{ advId, year, slug, url, kind }]. Pure. */
function parseAcpAdvisories(html) {
  const out = new Map();
  for (const m of String(html || '').matchAll(ACP_PDF_RE)) {
    const [, url, n, yRaw] = m;
    const year = yRaw.length === 2 ? 2000 + Number(yRaw) : Number(yRaw);
    const slug = (url.split('/').pop() || '')
      .replace(/\.pdf$/i, '')
      .replace(/^ADV-?\d{1,2}-?\d{2,4}-?/i, '')
      .replace(/[-_]+/g, ' ')
      .trim();
    const kind = /draft/i.test(slug) ? 'draft_restriction'
      : /outage|maintenance|chamber|culvert/i.test(slug) ? 'water_closure'
      : null; // reservation/booking-system noise
    const advId = `ADV-${n}-${year}`;
    if (kind && !out.has(advId)) out.set(advId, { advId, year, slug, url: url.startsWith('http') ? url : `https://pancanal.com${url}`, kind });
  }
  return [...out.values()];
}

/**
 * ACP advisories → events, current year only (the listing goes back years; a 2025 lane outage
 * is history, not a disruption). Effective dates are inside the PDFs — no startsAt in v1. Pure.
 */
function buildAcpEvents(advisories, now = Date.now(), currentYear = new Date(now).getUTCFullYear()) {
  return (advisories || [])
    .filter((a) => a.year === currentYear)
    .map((a) => ({
      id: `acp:${a.advId}`,
      country: null,
      kind: a.kind,
      summary: `Panama Canal: ${a.slug || 'advisory'} (official ACP advisory ${a.advId}${a.kind === 'draft_restriction' ? '; announced draft cuts arrive weeks ahead of effect' : ''}).`,
      source: 'acp-advisories',
      confidence: 0.9,
      startsAt: null,
      endsAt: null,
      waterway: 'panama_canal',
      url: a.url,
      observedAt: now,
    }));
}

// --- network edge (best-effort per source; a failure yields no events, never "all clear") -----

async function fetchRhineEvents(fetchImpl = fetch, now = Date.now()) {
  const events = [];
  for (const gauge of RHINE_GAUGES) {
    const res = await fetchImpl(`${PEGELONLINE_BASE}/stations/${gauge.station}/W/currentmeasurement.json`);
    if (!res.ok) throw new Error(`pegelonline ${res.status}`);
    const cur = await res.json();
    const reading = { cm: num(cur?.value), trendCm: null };
    try {
      const hist = await (await fetchImpl(`${PEGELONLINE_BASE}/stations/${gauge.station}/W/measurements.json?start=P3D`)).json();
      const first = num(hist?.[0]?.value), last = num(hist?.[hist.length - 1]?.value);
      if (first != null && last != null) reading.trendCm = last - first;
    } catch { /* trend is garnish */ }
    events.push(...buildRhineEvents(reading, gauge, now));
  }
  return events;
}

async function fetchVeniceEvents(fetchImpl = fetch, now = Date.now()) {
  const [levelRes, fcRes] = await Promise.all([fetchImpl(VENICE_LEVEL_URL), fetchImpl(VENICE_FORECAST_URL)]);
  if (!levelRes.ok || !fcRes.ok) throw new Error(`dati.venezia ${levelRes.status}/${fcRes.status}`);
  const levels = await levelRes.json();
  const forecast = await fcRes.json();
  const salute = (levels || []).find((s) => /punta salute/i.test(s?.stazione || ''));
  return buildVeniceEvents(parseVeniceMeters(salute?.valore), forecast, now);
}

async function fetchAcpEvents(fetchImpl = fetch, now = Date.now()) {
  const res = await fetchImpl(ACP_ADVISORIES_URL, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' }, // plain fetch UA gets bot-walled
  });
  if (!res.ok) throw new Error(`acp advisories ${res.status}`);
  return buildAcpEvents(parseAcpAdvisories(await res.text()), now);
}

/** All water sources, each best-effort — one gauge down never blanks the others. Network. */
async function fetchWaterLevelEvents(fetchImpl = fetch, now = Date.now()) {
  const events = [];
  try { events.push(...await fetchRhineEvents(fetchImpl, now)); } catch (e) { console.warn('[water] rhine fetch failed:', e.message); }
  try { events.push(...await fetchVeniceEvents(fetchImpl, now)); } catch (e) { console.warn('[water] venice fetch failed:', e.message); }
  try { events.push(...await fetchAcpEvents(fetchImpl, now)); } catch (e) { console.warn('[water] acp fetch failed:', e.message); }
  return events;
}

module.exports = {
  RHINE_GAUGES, MOSE_ACTIVATION_CM,
  classifyRhineLevel, buildRhineEvents, parseVeniceMeters, buildVeniceEvents,
  parseAcpAdvisories, buildAcpEvents,
  fetchRhineEvents, fetchVeniceEvents, fetchAcpEvents, fetchWaterLevelEvents,
};
