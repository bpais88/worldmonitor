'use strict';

// News explainer: conservatively matches recent headlines to a delayed ferry.
//
// News is noisy — a national headline usually isn't about a specific ferry — so
// this only fires on RECENT items that mention the operator OR the destination
// port AND a disruption keyword, and always reports LOW confidence. Better to
// say nothing than assert a false cause. The matcher is pure + unit-tested;
// the Google News RSS fetch is thin glue.

const https = require('https');
const { sourcesFor, disruptionVocabularyFor, foldText } = require('./country-sources.cjs');

const RELEVANCE_WINDOW_MS = 48 * 3_600_000;

function pubMsOf(item) {
  if (Number.isFinite(item.pubMs)) return item.pubMs;
  if (item.pubDate) { const t = Date.parse(item.pubDate); return Number.isFinite(t) ? t : null; }
  return null;
}

/**
 * Find the most relevant recent disruption headline for a delayed crossing.
 * Returns a single low-confidence Reason or null. Pure.
 */
function matchNewsToDelay(items, ctx, now = Date.now()) {
  if (!Array.isArray(items) || !items.length) return null;
  const operator = foldText((ctx?.operatorName || '').trim());
  const port = foldText((ctx?.portName || '').trim());
  if (!operator && !port) return null; // can't attribute -> stay silent
  // Vocabulary comes from the country-source registry (local-language strike/disruption terms) —
  // no country on the ctx defaults to Italy (Italian ports carry no country field).
  const { strikeTerms, disruptionTerms } = disruptionVocabularyFor(ctx?.destCountry);

  const candidates = items
    .map((it) => ({ it, pub: pubMsOf(it) }))
    .filter(({ pub }) => pub != null && now - pub <= RELEVANCE_WINDOW_MS)
    .sort((a, b) => b.pub - a.pub);

  for (const { it } of candidates) {
    const title = foldText(it.title || '');
    const mentionsEntity = (operator && title.includes(operator)) || (port && title.includes(port));
    if (!mentionsEntity) continue;
    const isStrike = strikeTerms.some((t) => title.includes(foldText(t)));
    const isDisruption = isStrike || disruptionTerms.some((t) => title.includes(foldText(t)));
    if (!isDisruption) continue;
    // Slightly higher (still low) when both operator AND port are named.
    const both = operator && port && title.includes(operator) && title.includes(port);
    return {
      source: 'news',
      kind: isStrike ? 'strike' : 'disruption',
      summary: it.title,
      url: it.link || undefined,
      confidence: both ? 0.45 : 0.35,
      detail: 'matched recent news headline',
    };
  }
  return null;
}

function getText(url, timeoutMs, redirectsLeft = 3) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: timeoutMs, headers: { 'User-Agent': 'Mozilla/5.0 worldmonitor-relay' } }, (res) => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers.location && redirectsLeft > 0) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        return resolve(getText(next, timeoutMs, redirectsLeft - 1));
      }
      if (status !== 200) { res.resume(); return reject(new Error(`HTTP ${status}`)); }
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve(body));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

// Minimal RSS <item> parse (title/link/pubDate) — enough for Google News RSS.
function parseRssItems(xml) {
  const items = [];
  const blocks = xml.split(/<item>/i).slice(1);
  for (const b of blocks) {
    const title = (b.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i) || [])[1];
    const link = (b.match(/<link>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/link>/i) || [])[1];
    const pubDate = (b.match(/<pubDate>([\s\S]*?)<\/pubDate>/i) || [])[1];
    if (title) items.push({ title: title.trim(), link: (link || '').trim(), pubDate: (pubDate || '').trim() });
  }
  return items;
}

/**
 * Fetch recent Google News results for a query (keyless RSS), in the COUNTRY'S locale — a
 * Rotterdam strike surfaces in Dutch press, a Valencia closure in Spanish press. Locale comes
 * from the country-source registry; no country defaults to Italy (pre-registry behavior).
 */
async function fetchNews(query, timeoutMs = 8000, country = undefined) {
  const loc = (sourcesFor(country) || sourcesFor('IT')).news;
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query + ' when:2d')}&hl=${loc.hl}&gl=${loc.gl}&ceid=${encodeURIComponent(loc.ceid)}`;
  const xml = await getText(url, timeoutMs);
  return parseRssItems(xml);
}

/** Explainer interface: explain(context) -> Reason[]. */
const newsExplainer = {
  id: 'news',
  async explain(ctx) {
    const operator = (ctx?.operatorName || '').trim();
    const port = (ctx?.destName || ctx?.portName || '').trim();
    if (!operator && !port) return [];
    // Query targets the entity + the country's freight noun, in the country's press locale.
    const subject = operator || port;
    const country = ctx?.destCountry;
    const noun = (sourcesFor(country) || sourcesFor('IT')).news.freightNoun;
    const items = await fetchNews(`${subject} ${noun}`, 8000, country);
    const reason = matchNewsToDelay(items, { operatorName: operator, portName: port, destCountry: country });
    return reason ? [reason] : [];
  },
};

module.exports = { matchNewsToDelay, parseRssItems, fetchNews, newsExplainer };
