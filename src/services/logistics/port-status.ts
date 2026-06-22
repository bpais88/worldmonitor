// Per-port freight congestion, from the relay's /ais/ports endpoint
// (proxied through /api/ais-ports on the web, direct to the relay in local dev).

const PORTS_PROXY_URL = '/api/ais-ports';
const LOCAL_RELAY_PORTS_URL = 'http://localhost:3004/ais/ports';

export type PortCongestion = 'clear' | 'busy' | 'congested';

export interface PortStatus {
  portId: string;
  name: string;
  lat: number;
  lon: number;
  region: string | null;
  /** Freight vessels stopped within ~8 km (waiting / berthed). */
  atPort: number;
  /** Freight vessels under way with this port as their resolved destination. */
  inbound: number;
  congestion: PortCongestion;
}

function toPortStatus(row: unknown): PortStatus | null {
  if (!row || typeof row !== 'object') return null;
  const r = row as Record<string, unknown>;
  if (typeof r.portId !== 'string' || typeof r.name !== 'string') return null;
  const congestion = r.congestion === 'congested' || r.congestion === 'busy' ? r.congestion : 'clear';
  return {
    portId: r.portId,
    name: r.name,
    lat: Number(r.lat),
    lon: Number(r.lon),
    region: typeof r.region === 'string' ? r.region : null,
    atPort: Number(r.atPort) || 0,
    inbound: Number(r.inbound) || 0,
    congestion,
  };
}

async function fetchPorts(base: string): Promise<PortStatus[]> {
  const res = await fetch(base, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`ais-ports request failed: ${res.status}`);
  const data = await res.json();
  const rows: unknown = (data as { ports?: unknown })?.ports;
  if (!Array.isArray(rows)) return [];
  const out: PortStatus[] = [];
  for (const row of rows) {
    const p = toPortStatus(row);
    if (p) out.push(p);
  }
  return out;
}

/** Fetch per-port freight congestion, with a local-relay fallback in dev. */
export async function getPortStatus(baseUrl: string = PORTS_PROXY_URL): Promise<PortStatus[]> {
  try {
    return await fetchPorts(baseUrl);
  } catch (err) {
    if (
      typeof window !== 'undefined' &&
      window.location.hostname === 'localhost' &&
      baseUrl !== LOCAL_RELAY_PORTS_URL
    ) {
      return fetchPorts(LOCAL_RELAY_PORTS_URL);
    }
    throw err;
  }
}
