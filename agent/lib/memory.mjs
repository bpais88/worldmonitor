// Agent memory: persists the per-vessel episode map across cron runs.
// Injectable backend — InMemory for tests/dry-run, Upstash REST for production
// (reuses the same store the relay already uses).

const KEY = 'agent:alerts:v1';

function mapToObj(map) {
  return Object.fromEntries(map);
}
function objToMap(obj) {
  return new Map(Object.entries(obj || {}));
}

/** In-process store — no cross-run persistence (fine for tests / --dry-run). */
export class InMemoryStore {
  constructor() { this._map = new Map(); }
  async load() { return new Map(this._map); }
  async save(map) { this._map = new Map(map); }
}

/** Upstash Redis REST store — durable across cron runs. */
export class UpstashStore {
  constructor(url, token) { this.url = url.replace(/\/$/, ''); this.token = token; }

  async load() {
    const res = await fetch(`${this.url}/get/${encodeURIComponent(KEY)}`, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    if (!res.ok) return new Map();
    const body = await res.json();
    if (!body || body.result == null) return new Map();
    try { return objToMap(JSON.parse(body.result)); } catch { return new Map(); }
  }

  async save(map) {
    const value = JSON.stringify(mapToObj(map));
    // POST body form: ["SET", key, value, "EX", ttl]
    await fetch(`${this.url}/set/${encodeURIComponent(KEY)}?EX=86400`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'text/plain' },
      body: value,
    });
  }
}

/** Pick a backend from env. */
export function makeStore(env = process.env) {
  if (env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN) {
    return new UpstashStore(env.UPSTASH_REDIS_REST_URL, env.UPSTASH_REDIS_REST_TOKEN);
  }
  return new InMemoryStore();
}
