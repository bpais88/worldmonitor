// Per-port freight congestion, from the relay's /ais/ports endpoint
// (proxied through /api/ais-ports on the web, direct to the relay in local dev).

import { relayFetch } from './relay-fetch';

const PORTS_PROXY_URL = '/api/ais-ports';
const LOCAL_RELAY_PORTS_URL = 'http://localhost:3004/ais/ports';

export type PortCongestion = 'clear' | 'busy' | 'congested';

/** Cumulative inbound-arrival counts by geometric ETA (a vessel <6 h out is in all four). */
export interface InboundEta {
  h6: number;
  h12: number;
  h24: number;
  h48: number;
}

export interface PortStatus {
  portId: string;
  name: string;
  lat: number;
  lon: number;
  region: string | null;
  /** Freight vessels stopped within ~8 km (waiting / berthed). */
  atPort: number;
  /** Of atPort, those at anchor — waiting for a berth (the queue / leading indicator). */
  atAnchor: number;
  /** Of atPort, those moored (berthed / being served). */
  atBerth: number;
  /** Freight vessels under way with this port as their resolved destination. */
  inbound: number;
  /** Of inbound, how many arrive within 6/12/24/48 h (geometric ETA). */
  inboundEta: InboundEta;
  congestion: PortCongestion;
}

function toPortStatus(row: unknown): PortStatus | null {
  if (!row || typeof row !== 'object') return null;
  const r = row as Record<string, unknown>;
  if (typeof r.portId !== 'string' || typeof r.name !== 'string') return null;
  const congestion = r.congestion === 'congested' || r.congestion === 'busy' ? r.congestion : 'clear';
  const eta = (r.inboundEta && typeof r.inboundEta === 'object') ? (r.inboundEta as Record<string, unknown>) : {};
  return {
    portId: r.portId,
    name: r.name,
    lat: Number(r.lat),
    lon: Number(r.lon),
    region: typeof r.region === 'string' ? r.region : null,
    atPort: Number(r.atPort) || 0,
    atAnchor: Number(r.atAnchor) || 0,
    atBerth: Number(r.atBerth) || 0,
    inbound: Number(r.inbound) || 0,
    inboundEta: {
      h6: Number(eta.h6) || 0,
      h12: Number(eta.h12) || 0,
      h24: Number(eta.h24) || 0,
      h48: Number(eta.h48) || 0,
    },
    congestion,
  };
}

function parsePorts(json: unknown): PortStatus[] {
  const rows: unknown = (json as { ports?: unknown })?.ports;
  if (!Array.isArray(rows)) return [];
  const out: PortStatus[] = [];
  for (const row of rows) {
    const p = toPortStatus(row);
    if (p) out.push(p);
  }
  return out;
}

/** Fetch per-port freight congestion, with a local-relay fallback in dev. */
export function getPortStatus(): Promise<PortStatus[]> {
  return relayFetch(PORTS_PROXY_URL, LOCAL_RELAY_PORTS_URL, parsePorts);
}
