// Thin authenticated GET against the relay, shared by all freight tools.
import { RELAY_URL, RELAY_SHARED_SECRET, RELAY_AUTH_HEADER } from './config.mjs';

export async function relayGet(path) {
  const headers = { Accept: 'application/json' };
  if (RELAY_SHARED_SECRET) headers[RELAY_AUTH_HEADER] = RELAY_SHARED_SECRET;
  const res = await fetch(`${RELAY_URL}${path}`, { headers });
  if (!res.ok) throw new Error(`relay ${path} -> HTTP ${res.status}`);
  return res.json();
}
