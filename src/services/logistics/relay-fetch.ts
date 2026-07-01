// Shared fetch for the relay-backed logistics endpoints: hit the Vercel proxy,
// and in local dev fall back to the relay directly (localhost only). The `parse`
// callback pulls the typed rows out of the JSON response.

async function fetchJson<T>(base: string, parse: (json: unknown) => T): Promise<T> {
  const res = await fetch(base, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`relay request failed: ${res.status} (${base})`);
  return parse(await res.json());
}

export async function relayFetch<T>(
  proxyUrl: string,
  localRelayUrl: string,
  parse: (json: unknown) => T,
): Promise<T> {
  try {
    return await fetchJson(proxyUrl, parse);
  } catch (err) {
    if (typeof window !== 'undefined' && window.location.hostname === 'localhost') {
      return fetchJson(localRelayUrl, parse);
    }
    throw err;
  }
}
