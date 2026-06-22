// Per-thread conversation memory, persisted via store.mjs (Upstash or in-memory
// fallback). Stores SIMPLIFIED text turns (user question + final answer) keyed by
// channel:thread — not raw tool-cycle messages, so re-feeding history can never
// leave a dangling tool_use without its tool_result. Keys expire after the TTL.
import { kvGet, kvSet } from '../store.mjs';

const TTL_SEC = 60 * 60; // forget a thread after 1h idle
const MAX_TURNS = 8;     // keep the last 8 Q&A pairs

export function threadKey(channel, thread) {
  return `mem:${channel}:${thread}`;
}

export async function getHistory(key) {
  const e = await kvGet(key);
  if (!e || (Number.isFinite(e.ts) && Date.now() - e.ts > TTL_SEC * 1000)) return [];
  return e.turns || [];
}

export async function appendTurn(key, userText, assistantText) {
  const turns = (await getHistory(key))
    .concat([{ role: 'user', content: userText }, { role: 'assistant', content: assistantText }])
    .slice(-MAX_TURNS * 2);
  await kvSet(key, { turns, ts: Date.now() }, TTL_SEC);
}
