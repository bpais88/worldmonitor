'use strict';

// STRIKE / DISRUPTION EVENT SOURCES (M3, spec assistant/DISRUPTION_SOURCES_SCOPE.md).
// Three layers, most→least structured:
//   1. MIT scioperi (IT) — the Transport Ministry's official strike registry RSS: ADVANCE notice,
//      sector, region, exact dates. The only structured national calendar among our countries;
//      verified live 2026-07-05 (https://scioperi.mit.gov.it/mit2/public/scioperi/rss).
//   2. Union-curated news — per-country union/entity names (from the country-source registry)
//      queried through the locale-aware Google News fetch; strike-term matched. The parity
//      workhorse: every country gets it.
//   3. GDELT — global news events; rate-limited (1 req/5s) and flaky, so strictly best-effort:
//      any non-JSON response is treated as "no data", never an error.
// Events normalize to: { id, country, kind: 'strike_scheduled'|'strike_report', summary, source,
// confidence, url?, startsAt?, endsAt?, sector?, region?, national?, unions? } — startsAt only
// from the structured calendar (headline date-guessing is how false alarms happen). M4's proactive
// watches key on startsAt; port-context uses strikeReasonForPort below.

const https = require('https');
const { COUNTRY_SOURCES, foldText } = require('./country-sources.cjs');
const { fetchNews } = require('./explainer-news.cjs');

const MIT_STRIKE_RSS = 'https://scioperi.mit.gov.it/mit2/public/scioperi/rss';
// Sectors that can touch a port's flow (maritime/port/haulage/logistics/general).
const PORT_SECTOR_RE = /maritt|portual|merci|logistic|general|multisettor/i;

function getText(url, timeoutMs = 10_000, redirectsLeft = 3) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: timeoutMs, headers: { 'User-Agent': 'Mozilla/5.0 worldmonitor-relay' } }, (res) => {
      const s = res.statusCode || 0;
      if (s >= 300 && s < 400 && res.headers.location && redirectsLeft > 0) {
        res.resume();
        return resolve(getText(new URL(res.headers.location, url).toString(), timeoutMs, redirectsLeft - 1));
      }
      if (s !== 200) { res.resume(); return reject(new Error(`HTTP ${s}`)); }
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve(body));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

/** "05/07/2026" (Italian DD/MM/YYYY, local date) → epoch ms at 00:00 UTC of that date. */
function parseItDate(s) {
  const m = String(s || '').match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (!m) return null;
  const t = Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
  return Number.isFinite(t) ? t : null;
}

// Fields appear " - "-separated in titles ("Settore: X - Rilevanza: Y") and <br/>-separated in
// descriptions ("Data fine: X<br/>Settore: Y") — stop at either delimiter, or end of text.
function field(text, label) {
  const m = text.match(new RegExp(`${label}:\\s*([\\s\\S]*?)(?=\\s+-\\s+[A-Za-zÀ-ü]+(?: [A-Za-zÀ-ü]+)*:|<br|\\n|$)`, 'i'));
  return m ? m[1].trim() : '';
}

/**
 * Parse the MIT scioperi RSS into normalized strike events. Pure.
 * Item title: "Data inizio: 05/07/2026 - Settore: Aereo - Rilevanza: Nazionale - Regione: Italia - Provincia: Tutte"
 * Description carries Data fine / modalità / Sindacati / Categoria as <br/>-separated fields.
 */
function parseMitStrikeRss(xml) {
  const out = [];
  const items = String(xml || '').split(/<item>/i).slice(1);
  for (const raw of items) {
    const block = raw.split(/<\/item>/i)[0];
    const title = ((block.match(/<title>([\s\S]*?)<\/title>/i) || [])[1] || '').trim();
    const desc = ((block.match(/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/i) || [])[1] || '');
    const guid = ((block.match(/<guid>([\s\S]*?)<\/guid>/i) || [])[1] || '').trim();
    const startsAt = parseItDate(field(title, 'Data inizio') || title);
    if (startsAt == null) continue;
    const sector = field(title, 'Settore');
    const region = field(title, 'Regione');
    const national = /nazionale/i.test(field(title, 'Rilevanza'));
    const unions = field(desc, 'Sindacati');
    const endsAt = parseItDate(field(desc, 'Data fine'));
    const mode = field(desc, 'modalità') || field(desc, 'modalita');
    out.push({
      id: guid || `mit:${startsAt}:${foldText(sector)}:${foldText(region)}`,
      country: 'IT',
      kind: 'strike_scheduled',
      source: 'mit-scioperi',
      confidence: 0.9, // official registry
      summary: `Scheduled ${sector || 'transport'} strike${national ? ' (national)' : region ? ` (${region})` : ''}${unions ? ` — ${unions}` : ''}${mode ? ` · ${mode}` : ''}`,
      url: 'https://scioperi.mit.gov.it',
      startsAt,
      endsAt: endsAt ?? startsAt,
      sector, region, national, unions,
      portRelevant: PORT_SECTOR_RE.test(sector),
    });
  }
  return out;
}

/** Fetch + parse the MIT registry; only events that can plausibly touch port flow. */
async function fetchMitStrikes(timeoutMs = 10_000) {
  const xml = await getText(MIT_STRIKE_RSS, timeoutMs);
  return parseMitStrikeRss(xml).filter((e) => e.portRelevant);
}

/** GDELT sourcecountry values per our codes. */
const GDELT_COUNTRY = { IT: 'italy', GB: 'unitedkingdom', ES: 'spain', NL: 'netherlands' };

/**
 * GDELT strike reports for one country — STRICTLY best-effort: rate limits and non-JSON responses
 * degrade to []. No startsAt (article date ≠ strike date); confidence low.
 */
async function fetchGdeltStrikes(country, timeoutMs = 15_000) {
  const src = COUNTRY_SOURCES[country];
  const gc = GDELT_COUNTRY[country];
  if (!src || !gc) return [];
  const strikeQ = src.strikeTerms.filter((t) => !t.includes(' ')).slice(0, 3).join(' OR ');
  const query = `(${strikeQ}) (port OR ${src.news.freightNoun.split(' ')[0]}) sourcecountry:${gc}`;
  const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(query)}&mode=artlist&maxrecords=10&format=json&timespan=7d`;
  try {
    const body = await getText(url, timeoutMs);
    const json = JSON.parse(body); // non-JSON (rate-limit text) throws → []
    return (json.articles || []).map((a) => ({
      id: `gdelt:${foldText(a.title || a.url || '')}`.slice(0, 120),
      country,
      kind: 'strike_report',
      source: 'gdelt',
      confidence: 0.4,
      summary: (a.title || '').trim(),
      url: a.url || undefined,
      seenAt: a.seendate ? Date.parse(String(a.seendate).replace(/(\d{4})(\d{2})(\d{2})T?(\d{2})(\d{2})(\d{2})Z?/, '$1-$2-$3T$4:$5:$6Z')) || undefined : undefined,
    })).filter((e) => e.summary);
  } catch { return []; }
}

/**
 * Union-curated strike reports for one country: query each curated union/entity name through the
 * locale-aware news fetch, keep headlines containing a strike term. All countries — the parity layer.
 */
async function fetchUnionStrikes(country, timeoutMs = 8000) {
  const src = COUNTRY_SOURCES[country];
  const unions = src && src.strikeSources && src.strikeSources.unions;
  if (!unions || !unions.length) return [];
  const terms = src.strikeTerms.map((t) => foldText(t));
  const out = [];
  for (const union of unions) {
    try {
      const items = await fetchNews(`"${union}"`, timeoutMs, country);
      for (const it of items.slice(0, 10)) {
        const title = foldText(it.title || '');
        if (!terms.some((t) => title.includes(t))) continue;
        out.push({
          id: `union:${foldText(union)}:${title.slice(0, 80)}`,
          country,
          kind: 'strike_report',
          source: 'union-news',
          confidence: 0.45,
          summary: it.title.trim(),
          url: it.link || undefined,
          union,
        });
      }
    } catch { /* per-union best-effort */ }
  }
  return out;
}

/**
 * Dedupe by id (highest confidence wins), THEN collapse duplicate NEWS reports: the same article is
 * routinely matched by several union queries, yielding distinct ids with a byte-identical headline
 * (e.g. one Amag Ambiente story arriving via both FIT-CISL and UILTRASPORTI). Only strike_report
 * events collapse, keyed on the folded headline — scheduled/official events are distinct facts and
 * never merge (two unions striking the same day are two strikes). Sort: scheduled-with-date first
 * (soonest), then reports by confidence.
 */
function mergeDisruptionEvents(lists) {
  const byId = new Map();
  for (const e of (lists || []).flat().filter(Boolean)) {
    const prev = byId.get(e.id);
    if (!prev || (e.confidence ?? 0) > (prev.confidence ?? 0)) byId.set(e.id, e);
  }
  const byHeadline = new Map(); // "country|folded headline" -> the event kept for it
  const out = [];
  for (const e of byId.values()) {
    // Scope the key by country: refreshDisruptions merges IT/GB/ES/NL reports in one call, and two
    // countries sharing a folded headline are separate country-scoped events — collapsing them
    // would drop one from its ?country= feed (and its port context). Only same-country dupes fold.
    const key = e.kind === 'strike_report' ? `${e.country ?? ''}|${foldText(e.summary || '')}` : '';
    if (!key) { out.push(e); continue; } // non-reports (and summary-less reports) never collapse
    const prev = byHeadline.get(key);
    if (!prev) { byHeadline.set(key, e); out.push(e); continue; }
    // Same story twice: keep the higher-confidence copy, preferring one that carries a url on a tie.
    const better = (e.confidence ?? 0) > (prev.confidence ?? 0)
      || ((e.confidence ?? 0) === (prev.confidence ?? 0) && !prev.url && e.url);
    if (better) {
      out[out.indexOf(prev)] = e;
      byHeadline.set(key, e);
    }
  }
  return out.sort((a, b) => {
    if (a.startsAt != null && b.startsAt != null) return a.startsAt - b.startsAt;
    if (a.startsAt != null) return -1;
    if (b.startsAt != null) return 1;
    return (b.confidence ?? 0) - (a.confidence ?? 0);
  });
}

/**
 * The port-context bridge: does any current/imminent event plausibly touch THIS port? Pure.
 * Scheduled events match by country + (national | region | port name in summary) and only within
 * their active window (±lookaheadMs); reports match by country + port/region name in the headline.
 */
function strikeReasonForPort(events, { country, region, portName } = {}, now = Date.now(), lookaheadMs = 7 * 24 * 3_600_000) {
  const c = country || 'IT';
  const fRegion = foldText(region || '');
  const fPort = foldText(portName || '');
  for (const e of events || []) {
    if (e.country !== c) continue;
    if (e.portRelevant === false) continue; // an air-sector strike must not decorate a port (undefined = keep)
    if (e.kind === 'strike_scheduled') {
      const active = e.startsAt != null && e.startsAt <= now + lookaheadMs && (e.endsAt == null || now <= e.endsAt + 24 * 3_600_000);
      if (!active) continue;
      const fSummary = foldText(e.summary);
      const fEventRegion = foldText(e.region || '');
      const areaHit = e.national || (fRegion && fEventRegion.includes(fRegion)) || (fPort && fSummary.includes(fPort));
      if (!areaHit) continue;
      const when = e.startsAt > now ? `starts ${new Date(e.startsAt).toISOString().slice(0, 10)}` : 'in effect';
      return { source: e.source, kind: 'strike', summary: `${e.summary} (${when})`, confidence: e.confidence, url: e.url, startsAt: e.startsAt };
    }
    // Reports: only attribute when the headline names the port (or its region) — country-level
    // chatter must not decorate every port in the country.
    const fSummary = foldText(e.summary);
    if ((fPort && fSummary.includes(fPort)) || (fRegion && fSummary.includes(fRegion))) {
      return { source: e.source, kind: 'strike', summary: e.summary, confidence: e.confidence, url: e.url };
    }
  }
  return null;
}

module.exports = {
  parseMitStrikeRss, fetchMitStrikes, fetchGdeltStrikes, fetchUnionStrikes,
  mergeDisruptionEvents, strikeReasonForPort, MIT_STRIKE_RSS, PORT_SECTOR_RE,
};
