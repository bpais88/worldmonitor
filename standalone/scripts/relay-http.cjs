'use strict';

// HTTP kernel for the freight relay — clean-room, written from the service's
// observable contract (captured from the running predecessor, 2026-08-08):
//   - GET + OPTIONS only; permissive CORS incl. the x-relay-key header
//   - /health (and /) are PUBLIC; every other route requires the shared secret
//     in the configured auth header (default x-relay-key) -> 401 otherwise
//   - gzip when the client advertises it
//   - per-IP fixed-window rate limit; limiter failure never blocks a request
//   - JSON errors: {"error": "..."}

const zlib = require('node:zlib');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-relay-key',
};

/** Per-IP fixed-window limiter. Window resets wholesale — cheap and good enough. */
function makeRateLimiter({ windowMs = 60_000, max = 300 } = {}) {
  let windowStart = Date.now();
  let counts = new Map();
  return function allow(ip, nowTs = Date.now(), routeMax = max) {
    if (nowTs - windowStart >= windowMs) { windowStart = nowTs; counts = new Map(); }
    const n = (counts.get(ip) || 0) + 1;
    counts.set(ip, n);
    return n <= routeMax;
  };
}

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

/** Send JSON (or a prebuilt string), gzipping when the client accepts it. */
function sendJson(req, res, status, headers, body) {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  const out = { 'Content-Type': 'application/json', ...CORS, ...headers };
  const accepts = String(req.headers['accept-encoding'] || '').includes('gzip');
  if (accepts && raw.length > 512) {
    zlib.gzip(raw, (err, buf) => {
      if (err || !buf) { res.writeHead(status, out); res.end(raw); return; }
      res.writeHead(status, { ...out, 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' });
      res.end(buf);
    });
    return;
  }
  res.writeHead(status, out);
  res.end(raw);
}

/**
 * Wrap a route table into a request handler.
 * routes: [{ match(pathname) -> bool, public?, rateMax?, handler(req,res,url) }]
 */
function makeHandler({ routes, secret, authHeader = 'x-relay-key', allowUnauthenticated = false, rateLimit }) {
  const limiter = makeRateLimiter(rateLimit);
  return async function handle(req, res) {
    const url = new URL(req.url || '/', 'http://relay.internal');
    const pathname = url.pathname;

    if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
    if (req.method !== 'GET' && pathname !== '/telegram') {
      return sendJson(req, res, 405, {}, { error: 'method not allowed' });
    }

    const route = routes.find((r) => r.match(pathname));
    if (!route) return sendJson(req, res, 404, {}, { error: 'not found' });

    if (!route.public && !allowUnauthenticated) {
      const provided = String(req.headers[authHeader] || '');
      if (!secret || provided !== secret) return sendJson(req, res, 401, {}, { error: 'unauthorized' });
    }
    if (!limiter(clientIp(req), Date.now(), route.rateMax)) {
      return sendJson(req, res, 429, { 'Retry-After': '60' }, { error: 'rate limited' });
    }

    try {
      await route.handler(req, res, url);
    } catch (e) {
      console.error(`[relay] ${pathname} handler failed:`, e?.stack || e);
      if (!res.headersSent) sendJson(req, res, 500, {}, { error: 'internal error' });
    }
  };
}

module.exports = { makeHandler, makeRateLimiter, sendJson, clientIp, CORS };
