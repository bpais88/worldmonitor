// Freight data tools — the FIRST entries in the agent's tool registry. Each tool
// is a self-contained { name, description, input_schema, handler }. To extend the
// agent, add more tool objects (here or in new files) and include them in the
// array passed to runAgent — the agent loop never changes.
import { relayGet } from '../relay.mjs';

const OPERATOR_IDS = ['tirrenia', 'gnv', 'moby', 'grimaldi', 'corsica_sardinia', 'snav', 'caronte'];

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
      'List tracked Italian freight vessels (cargo + RoPax). Optionally filter by operator id and/or a free-text name match. Returns name, operator, category, destination, speed, and whether delayed. Use for "which Grimaldi ships are sailing", "find vessel NAME", "cargo bound for X".',
    input_schema: {
      type: 'object',
      properties: {
        operator: { type: 'string', enum: OPERATOR_IDS, description: 'operator id to filter by' },
        nameContains: { type: 'string', description: 'case-insensitive vessel-name substring' },
        limit: { type: 'integer', description: 'max vessels to return (default 50)' },
      },
      additionalProperties: false,
    },
    handler: async ({ operator, nameContains, limit = 50 } = {}) => {
      // The relay can't filter by name, so a name search must pull the full set
      // and filter locally — otherwise a match past the first page is missed.
      const fetchLimit = nameContains ? 3000 : Math.min(limit, 200);
      const qs = new URLSearchParams({ types: 'cargo,passenger', freight: '1', limit: String(fetchLimit) });
      if (operator) qs.set('operator', operator);
      const j = await relayGet(`/ais/vessels?${qs}`);
      let vs = j.vessels || [];
      if (nameContains) {
        const q = String(nameContains).toLowerCase();
        vs = vs.filter((v) => (v.name || '').toLowerCase().includes(q));
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
];
