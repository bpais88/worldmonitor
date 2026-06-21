'use strict';

// AIS upstream API-key pool + rotation.
//
// aisstream throttles at the ACCOUNT level: a throttled key still connects and
// authenticates, but the server delivers zero frames (see the relay's no-data
// watchdog). A key from a different account sidesteps that, so the relay accepts
// a pool of keys and rotates to the next when a connection receives no data.
//
// Pure helpers (no I/O) so they unit-test without a socket.

/**
 * Ordered, de-duplicated key pool from the environment. Accepts a comma-
 * separated list in any of the supported vars, so a fallback key can be added
 * either as its own var or appended to the primary.
 */
function parseAisKeys(env = process.env) {
  const raw = [
    ...(env.AISSTREAM_API_KEY || '').split(','),
    ...(env.VITE_AISSTREAM_API_KEY || '').split(','),
    ...(env.AISSTREAM_API_KEY_FALLBACK || '').split(','),
  ];
  const out = [];
  const seen = new Set();
  for (const k of raw) {
    const key = k.trim();
    if (key && !seen.has(key)) { seen.add(key); out.push(key); }
  }
  return out;
}

/** Next index in the pool, wrapping around. Returns 0 for an empty pool. */
function nextKeyIndex(current, total) {
  if (!Number.isFinite(total) || total <= 0) return 0;
  return ((Number(current) || 0) + 1) % total;
}

module.exports = { parseAisKeys, nextKeyIndex };
