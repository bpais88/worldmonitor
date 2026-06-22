// Tiny KV store over Upstash Redis REST, with an in-memory fallback so the
// service runs locally (or before creds are set) without persistence. Backs both
// the agent's long-term memory and the proactive watches.
//
// Env: UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN. When unset, everything
// lives in a process-local Map (lost on restart) — same API, no persistence.

const URL = process.env.UPSTASH_REDIS_REST_URL || '';
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
export const PERSISTENT = !!(URL && TOKEN);

const mem = new Map();      // key -> JSON string
const sets = new Map();     // setKey -> Set<member>

async function redis(...cmd) {
  const res = await fetch(URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
  });
  const j = await res.json();
  if (j.error) throw new Error(`upstash: ${j.error}`);
  return j.result;
}

export async function kvGet(key) {
  if (!PERSISTENT) return mem.has(key) ? JSON.parse(mem.get(key)) : null;
  const r = await redis('GET', key);
  return r != null ? JSON.parse(r) : null;
}

export async function kvSet(key, value, ttlSec) {
  const s = JSON.stringify(value);
  if (!PERSISTENT) { mem.set(key, s); return; }
  if (ttlSec) await redis('SET', key, s, 'EX', String(ttlSec));
  else await redis('SET', key, s);
}

export async function kvDel(key) {
  if (!PERSISTENT) { mem.delete(key); return; }
  await redis('DEL', key);
}

export async function setAdd(setKey, member) {
  if (!PERSISTENT) { (sets.get(setKey) || sets.set(setKey, new Set()).get(setKey)).add(member); return; }
  await redis('SADD', setKey, member);
}

export async function setRem(setKey, member) {
  if (!PERSISTENT) { sets.get(setKey)?.delete(member); return; }
  await redis('SREM', setKey, member);
}

export async function setMembers(setKey) {
  if (!PERSISTENT) return [...(sets.get(setKey) || [])];
  return (await redis('SMEMBERS', setKey)) || [];
}
