'use strict';

// Meteoalarm explainer: official EU severe-weather warnings (meteoalarm.org),
// keyless ATOM/CAP feed. Authoritative complement to the raw Open-Meteo reading.
//
// We fetch the Italy feed once (cached, shared across vessels), keep active
// marine-relevant warnings (wind / coastal / thunderstorm), and match them to a
// flagged ferry by its destination region (cap:areaDesc == Italian admin region).
//
// Pure parse + match are unit-tested; the HTTP fetch is thin glue.

const https = require('https');

const FEED_URL = 'https://feeds.meteoalarm.org/feeds/meteoalarm-legacy-atom-italy';

// Awareness types that affect ferry crossings (vs heat/snow/etc.).
const MARINE_TYPE_RE = /coastal|wind|thunderstorm|gale|storm|sea|marine|rain|flood/i;
const COLOR_CONFIDENCE = { red: 0.85, orange: 0.7, yellow: 0.5 };

function tag(block, name) {
  const m = block.match(new RegExp(`<cap:${name}>([\\s\\S]*?)<\\/cap:${name}>`, 'i'));
  return m ? m[1].trim() : '';
}

/** Parse the Meteoalarm ATOM/CAP feed into structured warnings. Pure. */
function parseMeteoalarmFeed(xml) {
  if (!xml || typeof xml !== 'string') return [];
  const out = [];
  const blocks = xml.split(/<entry>/i).slice(1);
  for (const raw of blocks) {
    const block = raw.split(/<\/entry>/i)[0];
    const region = tag(block, 'areaDesc');
    const event = tag(block, 'event'); // e.g. "Orange Coastal Event Warning"
    if (!region || !event) continue;
    const colorMatch = event.match(/^(red|orange|yellow|green)\b/i);
    const color = colorMatch ? colorMatch[1].toLowerCase() : '';
    // Awareness type = text between the colour and "Warning".
    const awarenessType = event.replace(/^(red|orange|yellow|green)\s*/i, '').replace(/\s*warning\s*$/i, '').trim();
    const onset = Date.parse(tag(block, 'onset') || tag(block, 'effective'));
    const expires = Date.parse(tag(block, 'expires'));
    out.push({
      region,
      event,
      color,
      awarenessType,
      severity: tag(block, 'severity'),
      onset: Number.isFinite(onset) ? onset : null,
      expires: Number.isFinite(expires) ? expires : null,
    });
  }
  return out;
}

/**
 * Match an active marine-relevant warning for the ferry's destination region.
 * Picks the most severe (red > orange > yellow). Pure.
 */
function matchMeteoalarm(warnings, ctx, now = Date.now()) {
  const region = (ctx?.destRegion || '').trim().toLowerCase();
  if (!region || !Array.isArray(warnings)) return null;

  const active = warnings.filter((w) => {
    if ((w.region || '').trim().toLowerCase() !== region) return false;
    if (!MARINE_TYPE_RE.test(w.awarenessType || w.event || '')) return false;
    if (w.onset != null && now < w.onset) return false;
    if (w.expires != null && now > w.expires) return false;
    return true;
  });
  if (active.length === 0) return null;

  active.sort((a, b) => (COLOR_CONFIDENCE[b.color] ?? 0) - (COLOR_CONFIDENCE[a.color] ?? 0));
  const w = active[0];
  const conf = COLOR_CONFIDENCE[w.color] ?? 0.5;
  const type = (w.awarenessType || 'weather').toLowerCase();
  return {
    source: 'meteoalarm',
    kind: 'marine_warning',
    summary: `Official ${w.color || ''} ${type} warning for ${w.region}`.replace(/\s+/g, ' ').trim(),
    confidence: conf,
    url: 'https://meteoalarm.org',
    detail: w.expires ? `valid until ${new Date(w.expires).toISOString().slice(0, 16).replace('T', ' ')}Z` : undefined,
  };
}

function getText(url, timeoutMs, redirectsLeft = 3) {
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

/** Fetch + parse the Italy feed (one call for the whole country). */
async function fetchMeteoalarmItaly(timeoutMs = 8000) {
  const xml = await getText(FEED_URL, timeoutMs);
  return parseMeteoalarmFeed(xml);
}

/** Explainer interface: getWarnings() returns the cached parsed feed. */
function makeMeteoalarmExplainer(getWarnings) {
  return {
    id: 'meteoalarm',
    async explain(ctx) {
      if (!ctx || !ctx.destRegion) return [];
      const reason = matchMeteoalarm(getWarnings() || [], ctx, Date.now());
      return reason ? [reason] : [];
    },
  };
}

module.exports = { parseMeteoalarmFeed, matchMeteoalarm, fetchMeteoalarmItaly, makeMeteoalarmExplainer, FEED_URL };
