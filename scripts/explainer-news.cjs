'use strict';

// News explainer: conservatively matches recent headlines to a delayed ferry.
//
// News is noisy — a national headline usually isn't about a specific ferry — so
// this only fires on RECENT items that mention the operator OR the destination
// port AND a disruption keyword, and always reports LOW confidence. Better to
// say nothing than assert a false cause. The matcher is pure + unit-tested;
// the Google News RSS fetch is thin glue.

const https = require('https');

const RELEVANCE_WINDOW_MS = 48 * 3_600_000;

// EN + IT terms (Italian local press is where ferry disruptions actually surface).
const STRIKE_TERMS = ['strike', 'sciopero', 'walkout'];
const DISRUPTION_TERMS = [
  'cancel', 'cancell', 'delay', 'ritard', 'suspend', 'sospes', 'sospeso',
  'maltempo', 'mareggiata', 'closed', 'chiuso', 'chiusura', 'blocked', 'bloccat',
  'disrupt', 'halt', 'stop',
];

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
  const operator = (ctx?.operatorName || '').trim().toLowerCase();
  const port = (ctx?.portName || '').trim().toLowerCase();
  if (!operator && !port) return null; // can't attribute -> stay silent

  const candidates = items
    .map((it) => ({ it, pub: pubMsOf(it) }))
    .filter(({ pub }) => pub != null && now - pub <= RELEVANCE_WINDOW_MS)
    .sort((a, b) => b.pub - a.pub);

  for (const { it } of candidates) {
    const title = (it.title || '').toLowerCase();
    const mentionsEntity = (operator && title.includes(operator)) || (port && title.includes(port));
    if (!mentionsEntity) continue;
    const isStrike = STRIKE_TERMS.some((t) => title.includes(t));
    const isDisruption = isStrike || DISRUPTION_TERMS.some((t) => title.includes(t));
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

/** Fetch recent Google News results for a query (keyless RSS, Italian locale). */
async function fetchNews(query, timeoutMs = 8000) {
  // Italian locale — ferry disruptions surface in Italian local press. The
  // disruption/recency filtering happens in matchNewsToDelay, so the query stays
  // broad (entity + "traghetti") and the matcher keeps only relevant hits.
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query + ' when:2d')}&hl=it&gl=IT&ceid=IT:it`;
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
    // Query targets the most likely disruption vocabulary for this entity.
    const subject = operator || port;
    const items = await fetchNews(`${subject} traghetti`);
    const reason = matchNewsToDelay(items, { operatorName: operator, portName: port });
    return reason ? [reason] : [];
  },
};

module.exports = { matchNewsToDelay, parseRssItems, fetchNews, newsExplainer };
