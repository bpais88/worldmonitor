// Freight data tools — the FIRST entries in the agent's tool registry. Each tool
// is a self-contained { name, description, input_schema, handler }. To extend the
// agent, add more tool objects (here or in new files) and include them in the
// array passed to runAgent — the agent loop never changes.
import { relayGet } from '../relay.mjs';

const OPERATOR_IDS = ['tirrenia', 'gnv', 'moby', 'grimaldi', 'corsica_sardinia', 'snav', 'caronte'];

// Great-circle distance in km (for "vessels near a port").
function haversineKm(a, b) {
  if (![a.lat, a.lon, b.lat, b.lon].every(Number.isFinite)) return Infinity;
  const R = 6371, toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat), dLon = toRad(b.lon - a.lon);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

const ALL_FREIGHT = '/ais/vessels?types=cargo,passenger&freight=1&limit=3000';

export const freightTools = [
  {
    name: 'get_port_congestion',
    description:
      'Congestion status for Italian commercial freight ports. Returns, per port: congestion level (clear/busy/congested), atPort (freight vessels waiting/berthed within ~8 km) and inbound (under way, bound there). Use for "which ports are busy/congested", "how many vessels waiting at X".',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => {
      const j = await relayGet('/ais/ports');
      return {
        freightTracked: j.freightTracked,
        ports: (j.ports || []).map((p) => ({
          port: p.name, region: p.region, congestion: p.congestion, atPort: p.atPort, inbound: p.inbound,
        })),
      };
    },
  },
  {
    name: 'find_freight_vessels',
    description:
      'List tracked Italian freight vessels (cargo + RoPax). Filter by operator id, a vessel-name substring, destination (an AIS LOCODE like ITNAP — use when you know the code), and/or delayedOnly. Returns name, operator, category, destination, speed, and whether delayed. Use for "which Grimaldi ships are sailing", "find vessel NAME", "delayed Moby ships".',
    input_schema: {
      type: 'object',
      properties: {
        operator: { type: 'string', enum: OPERATOR_IDS, description: 'operator id to filter by' },
        nameContains: { type: 'string', description: 'case-insensitive vessel-name substring' },
        destinationContains: { type: 'string', description: 'match the AIS destination, a LOCODE substring (e.g. "ITNAP" for Naples)' },
        delayedOnly: { type: 'boolean', description: 'only vessels currently flagged delayed' },
        limit: { type: 'integer', description: 'max vessels to return (default 50)' },
      },
      additionalProperties: false,
    },
    handler: async ({ operator, nameContains, destinationContains, delayedOnly, limit = 50 } = {}) => {
      // Any local filter must pull the full set first — otherwise a match past the
      // first page is missed (the relay only filters by operator server-side).
      const hasLocalFilter = !!(nameContains || destinationContains || delayedOnly);
      const fetchLimit = hasLocalFilter ? 3000 : Math.min(limit, 200);
      const qs = new URLSearchParams({ types: 'cargo,passenger', freight: '1', limit: String(fetchLimit) });
      if (operator) qs.set('operator', operator);
      const j = await relayGet(`/ais/vessels?${qs}`);
      let vs = j.vessels || [];
      if (nameContains) {
        const q = String(nameContains).toLowerCase();
        vs = vs.filter((v) => (v.name || '').toLowerCase().includes(q));
      }
      if (destinationContains) {
        const d = String(destinationContains).toLowerCase();
        vs = vs.filter((v) => (v.destination || '').toLowerCase().includes(d));
      }
      if (delayedOnly) {
        vs = vs.filter((v) => v.delay && (v.delay.slipping || v.delay.stalled));
      }
      return {
        count: vs.length,
        vessels: vs.slice(0, limit).map((v) => ({
          name: v.name, operator: v.operatorName || null, category: v.category,
          destination: v.destination || null, speedKnots: v.speed,
          delayed: !!(v.delay && (v.delay.slipping || v.delay.stalled)),
        })),
      };
    },
  },
  {
    name: 'get_delayed_vessels',
    description:
      'Freight vessels currently flagged delayed (predicted arrival slipping, or stalled mid-route), each with the likely cause(s) — port congestion, rough weather, vessel-specific. Use for "what is delayed", "why is X late", "give me a delay report".',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => {
      const j = await relayGet('/ais/vessels?types=cargo,passenger&freight=1&limit=3000');
      const delayed = (j.vessels || []).filter((v) => v.delay && (v.delay.slipping || v.delay.stalled));
      return {
        count: delayed.length,
        delayed: delayed.map((v) => ({
          name: v.name, operator: v.operatorName || null, destination: v.destination || null,
          etaGrowthMin: v.delay.etaGrowthMin, stalled: !!v.delay.stalled,
          reasons: (v.delay.reasons || []).map((r) => r.summary),
        })),
      };
    },
  },
  {
    name: 'get_vessel',
    description:
      'Look up ONE freight vessel by name (substring ok), IMO, or MMSI. Returns position, operator, destination, speed, status, dimensions, draught, ETA, and delay + cause if any. Use for "tell me about VESSEL", "where is X", "is X delayed".',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'vessel name (substring), IMO, or MMSI' } },
      required: ['query'],
      additionalProperties: false,
    },
    handler: async ({ query }) => {
      const j = await relayGet(ALL_FREIGHT);
      const q = String(query).toLowerCase();
      const matches = (j.vessels || []).filter(
        (v) => (v.name || '').toLowerCase().includes(q) || String(v.imo || '') === query || String(v.mmsi || '') === query,
      );
      if (!matches.length) return { found: false, query };
      return {
        found: true,
        matches: matches.slice(0, 5).map((v) => ({
          name: v.name, mmsi: v.mmsi, imo: v.imo || null, operator: v.operatorName || null,
          category: v.category, destination: v.destination || null, speedKnots: v.speed,
          navStatus: v.navStatus, lengthM: v.length, beamM: v.beam, draughtM: v.draught,
          etaAis: v.etaAis || null, delayed: !!(v.delay && (v.delay.slipping || v.delay.stalled)),
          delayReasons: v.delay && v.delay.reasons ? v.delay.reasons.map((r) => r.summary) : [],
        })),
      };
    },
  },
  {
    name: 'get_port',
    description:
      'Deep dive on one commercial freight port: its congestion level + inbound count, plus the freight vessels physically AT the port right now (within ~8 km, with names/speed/status). Use for "what is happening at Genoa", "which ships are at Ravenna".',
    input_schema: {
      type: 'object',
      properties: { port: { type: 'string', description: 'port name or id, e.g. "Genoa"' } },
      required: ['port'],
      additionalProperties: false,
    },
    handler: async ({ port }) => {
      const [portsRes, vesselsRes] = await Promise.all([relayGet('/ais/ports'), relayGet(ALL_FREIGHT)]);
      const q = String(port).toLowerCase();
      const p = (portsRes.ports || []).find(
        (x) => x.name.toLowerCase() === q || String(x.portId).toLowerCase() === q || x.name.toLowerCase().includes(q),
      );
      if (!p) return { found: false, port };
      const atPort = (vesselsRes.vessels || [])
        .filter((v) => haversineKm(v, p) <= 8)
        .map((v) => ({ name: v.name, operator: v.operatorName || null, speedKnots: v.speed, navStatus: v.navStatus }));
      return {
        found: true,
        port: p.name, region: p.region, congestion: p.congestion,
        atPortCount: p.atPort, inboundCount: p.inbound, vesselsAtPort: atPort,
      };
    },
  },
];
