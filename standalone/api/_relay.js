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
      const valid = (process.env.API_VALID_KEYS || '').split(',').map((s) => s.trim()).filter(Boolean);
      const provided = request.headers.get('x-api-key') || new URL(request.url).searchParams.get('key') || '';
      if (valid.length && !valid.includes(provided)) return json(401, { error: 'invalid api key' });
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
