// Per-workspace token usage metering — OBSERVE-ONLY for now (no cap enforced).
// Tokens are the true internal cost unit (output costs several× input); we record
// them per workspace per day so we can size a credit/limit later from real numbers.
// Backed by store.mjs (Upstash or in-memory fallback). Daily keys auto-expire.
import { kvGet, kvSet } from './store.mjs';

const TTL_SEC = 60 * 60 * 24 * 40; // keep ~40 days of daily counters
const day = (now) => new Date(now).toISOString().slice(0, 10);
const key = (teamId, d) => `usage:${teamId}:${d}`;

/** Add one interaction's token usage to today's per-workspace counter. */
export async function recordUsage(teamId, { input = 0, output = 0 } = {}, now = Date.now()) {
  if (!teamId) return null;
  const k = key(teamId, day(now));
  const cur = (await kvGet(k)) || { input: 0, output: 0, messages: 0 };
  const next = { input: cur.input + input, output: cur.output + output, messages: cur.messages + 1, ts: now };
  await kvSet(k, next, TTL_SEC);
  return next;
}

/** Read today's usage for a workspace (for logging / a future cap check). */
export async function getUsage(teamId, now = Date.now()) {
  return (teamId && (await kvGet(key(teamId, day(now))))) || { input: 0, output: 0, messages: 0 };
}
