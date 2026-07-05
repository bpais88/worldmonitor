// Freight data tools — the FIRST entries in the agent's tool registry. Each tool
// is a self-contained { name, description, input_schema, handler }. To extend the
// agent, add more tool objects (here or in new files) and include them in the
// array passed to runAgent — the agent loop never changes.
import { relayGet } from '../relay.mjs';
// Reuse the relay's exact LOCODE→port resolver (no duplication) to name inbound vessels.
import ferryEta from '../../scripts/ferry-eta.cjs';

const { resolveDestinationPort } = ferryEta;
const OPERATOR_IDS = ['tirrenia', 'gnv', 'moby', 'grimaldi', 'corsica_sardinia', 'snav', 'caronte'];

// Pull the relay's freshness signals into a compact note so the agent can caveat a
// count it would otherwise quote as authoritative. Only present when not fully fresh.
function feedNote(j) {
  if (j && j.warming) return { warming: true, note: 'Feed is still warming up after a restart — counts are partial, ask again shortly.' };
  if (j && j.stale) return { stale: true, note: `Feed may be stale — last upstream update ~${j.ageSec ?? '?'}s ago.` };
  return null;
}

// Live-ETA view for a vessel: prefer the relay's freshly-computed ETA (distance ÷
// speed, recomputed each poll) over the stale captain-entered AIS ETA, and never
// surface an ETA when the vessel is stopped/at port. etaTrendMin is the signed
// change vs earlier in this leg (+ = arriving later/slipping, − = ahead).
export function etaView(v, now = Date.now()) {
  if (!Number.isFinite(v.etaTs)) return {}; // stopped / at port / no destination → no ETA
  const out = {
    eta: new Date(v.etaTs).toISOString().slice(0, 16).replace('T', ' ') + 'Z',
    etaInHours: Math.round((v.etaTs - now) / 360000) / 10,
  };
  if (Number.isFinite(v.etaDeltaMin)) {
    out.etaTrendMin = v.etaDeltaMin;          // signed: + later, − earlier (recent window)
    out.etaTrendWindowMin = v.etaWindowMin;   // measured over this many minutes
  }
  if (Number.isFinite(v.etaVsDepartureMin)) {
    out.etaVsDepartureMin = v.etaVsDepartureMin; // signed drift vs the trip's departure ETA
    out.voyageAgeMin = v.voyageAgeMin;           // how long the trip has been under way
  }
  return out;
}

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
      'Congestion status for European commercial freight ports (Italy, the UK, Spain, the Netherlands). Returns, per port: congestion level (clear/busy/congested), atPort (freight vessels waiting/berthed within ~8 km) and inbound (under way, bound there). If the result has a "feed" field (warming/stale), LEAD your answer with that caveat — the counts are partial or aging. Use for "which ports are busy/congested", "how many vessels waiting at X".',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => {
      const j = await relayGet('/ais/ports');
      const feed = feedNote(j);
      return {
        freightTracked: j.freightTracked,
        ...(feed ? { feed } : {}),
        ports: (j.ports || []).map((p) => ({
          port: p.name, region: p.region, congestion: p.congestion, atPort: p.atPort, inbound: p.inbound,
        })),
      };
    },
  },
  {
    name: 'find_freight_vessels',
    description:
      'List tracked European freight vessels (cargo + RoPax) across Italy, the UK, Spain, and the Netherlands. Filter by operator id, a vessel-name substring, destination (an AIS LOCODE like ITNAP — use when you know the code), and/or delayedOnly. Returns name, operator, category, destination, speed, whether delayed, and the live ETA. ETA fields: "eta" (computed live arrival, UTC) + "etaInHours"; "etaTrendMin" is how much the ETA has moved over the recent window "etaTrendWindowMin"; "etaVsDepartureMin" is the drift vs the trip\'s DEPARTURE ETA over "voyageAgeMin" minutes (+ = later, − = ahead). No eta field = the vessel is stopped/at port. Prefer this live ETA; do not invent one. If the result has a "feed" field (warming/stale), lead with that caveat — the count is partial or aging. Use for "which Grimaldi ships are sailing", "find vessel NAME", "delayed Moby ships", "when does X arrive".',
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
      const feed = feedNote(j);
      return {
        count: vs.length,
        ...(feed ? { feed } : {}),
        vessels: vs.slice(0, limit).map((v) => ({
          name: v.name, operator: v.operatorName || null, category: v.category,
          destination: v.destination || null, speedKnots: v.speed, ...etaView(v),
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
      const feed = feedNote(j);
      return {
        count: delayed.length,
        ...(feed ? { feed } : {}),
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
      'Look up ONE freight vessel by name (substring ok), IMO, or MMSI. Returns position, operator, destination, speed, status, dimensions, draught, live ETA, and delay + cause if any. ETA fields: "eta" (computed live arrival, UTC) + "etaInHours"; "etaTrendMin" is the signed change since earlier this trip (+ later, − ahead) over the recent window "etaTrendWindowMin"; "etaVsDepartureMin" is the drift vs the trip\'s DEPARTURE ETA over "voyageAgeMin" min. No eta field = stopped/at port. Use for "tell me about VESSEL", "where is X", "when does X arrive", "is X delayed".',
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
      const feed = feedNote(j);
      if (!matches.length) return { found: false, query, ...(feed ? { feed } : {}) };
      return {
        found: true,
        ...(feed ? { feed } : {}),
        matches: matches.slice(0, 5).map((v) => ({
          name: v.name, mmsi: v.mmsi, imo: v.imo || null, operator: v.operatorName || null,
          category: v.category, destination: v.destination || null, speedKnots: v.speed,
          navStatus: v.navStatus, lengthM: v.length, beamM: v.beam, draughtM: v.draught,
          ...etaView(v), delayed: !!(v.delay && (v.delay.slipping || v.delay.stalled)),
          delayReasons: v.delay && v.delay.reasons ? v.delay.reasons.map((r) => r.summary) : [],
        })),
      };
    },
  },
  {
    name: 'get_port',
    description:
      'Deep dive on one commercial freight port: congestion level, the freight vessels physically AT the port (within ~8 km), and the vessels INBOUND (under way with this port as their resolved destination), each with names/speed. Busy ports may carry `context`: candidate WHY-reasons (news, official weather alerts, crane-wind, above-baseline anomaly) with confidence — present these hedged ("possibly related"), never as the established cause. Use for "what is happening at Genoa", "which ships are at / heading to Ravenna", "why is Rotterdam busy".',
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
      const feed = feedNote(portsRes);
      if (!p) return { found: false, port, ...(feed ? { feed } : {}) };
      const vessels = vesselsRes.vessels || [];
      const atPortMmsi = new Set();
      const atPort = [];
      for (const v of vessels) {
        if (haversineKm(v, p) <= 8) {
          atPortMmsi.add(v.mmsi);
          atPort.push({ name: v.name, operator: v.operatorName || null, speedKnots: v.speed, navStatus: v.navStatus });
        }
      }
      // Inbound: under way, destination resolves to this port, and not already at it.
      const inbound = [];
      for (const v of vessels) {
        if (atPortMmsi.has(v.mmsi)) continue;
        if (!(Number.isFinite(v.speed) && v.speed > 1)) continue;
        if (!v.destination) continue;
        const dest = resolveDestinationPort(v.destination);
        if (dest && dest.portId === p.portId) {
          inbound.push({ name: v.name, operator: v.operatorName || null, speedKnots: v.speed, ...etaView(v) });
        }
      }
      return {
        found: true,
        ...(feed ? { feed } : {}),
        port: p.name, region: p.region, congestion: p.congestion,
        atPortCount: p.atPort, vesselsAtPort: atPort,
        inboundCount: inbound.length, vesselsInbound: inbound,
      };
    },
  },
  {
    name: 'get_voyage_stats',
    description:
      'How many freight trips Marco registered per day (a trip = a vessel heading to a tracked port, counted when first seen on that leg). Returns a per-day breakdown and the total. Use for "how many trips today/this week", "how many voyages did you track", "trip volume". Counts are UTC days and may be slightly inflated by AIS destination noise.',
    input_schema: {
      type: 'object',
      properties: { days: { type: 'integer', description: 'how many days back to include (default 14, max 120)' } },
      additionalProperties: false,
    },
    handler: async ({ days = 14 } = {}) => {
      const j = await relayGet(`/ais/voyages/daily?days=${Math.min(Math.max(days, 1), 120)}`);
      return { totalTrips: j.totalTrips, days: j.days, daily: j.daily };
    },
  },
];
