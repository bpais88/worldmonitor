// Clean-room edge proxy factory for the /api/ais-* functions.
//
// Written from the observable contract the eight proxy files consume:
//   createRelayHandler({ relayPath, cacheHeaders, timeout, requireApiKey, requireRateLimit })
// The upstream implementation (AGPL) is not used. Semantics here are deliberately
// simple: forward the request (with query string) to the relay, attach the shared
// secret, time out, and pass the JSON back with CORS + caching headers.
//
// Env: RELAY_URL (e.g. https://relay.example.app), RELAY_SHARED_SECRET,
//      RELAY_AUTH_HEADER (default x-relay-key), API_VALID_KEYS (comma list, only
//      when requireApiKey), UPSTASH_REDIS_REST_URL/TOKEN (only when requireRateLimit).

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-api-key',
};

/**
 * Constant-time key check for the edge runtime (WebCrypto, no node:crypto). Hashing first makes
 * both operands a fixed 32 bytes, so neither the key's length nor its prefix leaks through timing;
 * the XOR accumulation then compares every byte instead of returning at the first difference.
 */
async function matchesAnyKey(provided, validKeys) {
  const digest = async (v) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(v))));
  const given = await digest(provided);
  let matched = false;
  for (const key of validKeys) {
    const want = await digest(key);
    let diff = 0;
    for (let i = 0; i < want.length; i++) diff |= given[i] ^ want[i];
    if (diff === 0) matched = true; // no early break — every candidate costs the same
  }
  return matched;
}

function json(status, body, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS, ...extra },
  });
}

async function overRateLimit(request) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return false; // not configured -> no limiting
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  const windowKey = `ratelimit:${ip}:${Math.floor(Date.now() / 60_000)}`;
  try {
    const res = await fetch(`${url}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([["INCR", windowKey], ["EXPIRE", windowKey, "90"]]),
    });
    const out = await res.json();
    const count = Number(out?.[0]?.result ?? 0);
    return count > 120; // 120 req/min/ip
  } catch {
    return false; // limiter failure must never take the API down
  }
}

export function createRelayHandler({
  relayPath,
  cacheHeaders = {},
  timeout = 10_000,
  requireApiKey = false,
  requireRateLimit = false,
} = {}) {
  return async function handler(request) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
    if (request.method !== 'GET') return json(405, { error: 'method not allowed' });

    if (requireApiKey) {
      // FAIL CLOSED: an unset API_VALID_KEYS must deny, not wave everything through. This proxy
      // holds RELAY_SHARED_SECRET, so waving through would turn it into an open, credentialed
      // gateway to the relay — worse than having no proxy at all.
      const valid = (process.env.API_VALID_KEYS || '').split(',').map((s) => s.trim()).filter(Boolean);
      // Header only — a key in the query string leaks into browser history, Referer and proxy logs.
      const provided = request.headers.get('x-api-key') || '';
      if (!valid.length) return json(503, { error: 'API_VALID_KEYS not configured' });
      if (!(await matchesAnyKey(provided, valid))) return json(401, { error: 'invalid api key' });
    }
    if (requireRateLimit && (await overRateLimit(request))) {
      return json(429, { error: 'rate limited' }, { 'Retry-After': '60' });
    }

    const base = process.env.RELAY_URL;
    if (!base) return json(503, { error: 'RELAY_URL not configured' });
    const incoming = new URL(request.url);
    const target = `${base.replace(/\/$/, '')}${relayPath}${incoming.search}`;

    const headers = {};
    const secret = process.env.RELAY_SHARED_SECRET;
    if (secret) headers[(process.env.RELAY_AUTH_HEADER || 'x-relay-key').toLowerCase()] = secret;

    try {
      const upstream = await fetch(target, { headers, signal: AbortSignal.timeout(timeout) });
      const body = await upstream.text();
      return new Response(body, {
        status: upstream.status,
        headers: {
          'Content-Type': upstream.headers.get('Content-Type') || 'application/json',
          ...CORS_HEADERS,
          ...(upstream.ok ? cacheHeaders : { 'Cache-Control': 'no-store' }),
        },
      });
    } catch (e) {
      const timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError';
      return json(timedOut ? 504 : 502, { error: timedOut ? 'relay timeout' : 'relay unreachable' });
    }
  };
}
