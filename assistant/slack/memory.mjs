// Per-thread conversation memory (in-memory). Stores SIMPLIFIED text turns
// (user question + final assistant answer) keyed by channel:thread — not the raw
// tool-cycle messages, so re-feeding history can never leave a dangling tool_use
// without its tool_result. Good enough for follow-ups; swap for Upstash later.

const store = new Map(); // key -> { turns: [{role, content}], ts }
const TTL_MS = 60 * 60 * 1000; // forget a thread after 1h idle
const MAX_TURNS = 8;           // keep the last 8 Q&A pairs

export function threadKey(channel, thread) {
  return `${channel}:${thread}`;
}

export function getHistory(key) {
  const e = store.get(key);
  if (!e || Date.now() - e.ts > TTL_MS) {
    store.delete(key);
    return [];
  }
  return e.turns;
}

// Drop threads idle past the TTL. Lazy per-key eviction (in getHistory) never
// reclaims threads that are never messaged again, so sweep on each write.
function sweep(now) {
  for (const [k, e] of store) if (now - e.ts > TTL_MS) store.delete(k);
}

export function appendTurn(key, userText, assistantText) {
  const now = Date.now();
  sweep(now);
  const turns = getHistory(key)
    .concat([{ role: 'user', content: userText }, { role: 'assistant', content: assistantText }])
    .slice(-MAX_TURNS * 2);
  store.set(key, { turns, ts: now });
}
