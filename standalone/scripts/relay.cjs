'use strict';

// Freight relay — clean-room entry point composing the domain modules.
//
// This file replaces the fork-era relay whose HTTP/ingest skeleton was upstream-
// licensed. It is written from (a) the domain modules' own APIs and (b) the
// predecessor's OBSERVED HTTP contract (captured 2026-08-08: auth matrix, headers,
// response shapes — see relay-http.test.cjs). Endpoints deliberately NOT present:
// the fork's worldmonitor tenants (/oref, /opensky, /rss, /worldbank, /polymarket,
// /ucdp-events, /notam, /yahoo-chart, /youtube-live, /telegram) — never part of
// this product.
//
// Layout: config → state → ingest (aisstream ws + Marinesia tile poll) → ticks
// (delays, geofence/port history, disruptions, meteoalarm, port context, baselines)
// → HTTP routes → main(). Exported pieces keep the server testable without network.

const http = require('node:http');

const { makeHandler, sendJson } = require('./relay-http.cjs');
const { makeVesselStore } = require('./vessel-store.cjs');
const {
  MARINESIA_TILES, tileIndexFor, fetchTile, normalizeMarinesiaVessel, VESSEL_CAP,
} = require('./marinesia.cjs');
const { relayFreshness, tileFreshness, DEFAULT_STALE_MS } = require('./freshness.cjs');
const { computeAllPortStatus, smoothPortStatus, DEFAULTS: PORT_DEFAULTS } = require('./port-status.cjs');
const { buildPortGeofences, computeMembership, diffMembership } = require('./geofence-engine.cjs');
const { parseBbox, parseTypes, clampLimit, buildVesselList } = require('./ais-vessels-query.cjs');
const { resolveDestinationPort, etaFor, resolveOperator, resolveOperatorName, isFreightVessel } = require('./ferry-eta.cjs');
const { recordSnapshot, detectDrift, updateVoyage } = require('./eta-history.cjs');
const db = require('./db.cjs');
const { fetchMitStrikes, fetchGdeltStrikes, fetchUnionStrikes, mergeDisruptionEvents, strikeReasonForPort } = require('./strike-sources.cjs');
const { fetchWaterLevelEvents } = require('./water-levels.cjs');
const { fetchChokepointEvents } = require('./chokepoint-markets.cjs');
const { COUNTRY_SOURCES } = require('./country-sources.cjs');
const { runExplainers } = require('./delay-explainers.cjs');
const { weatherExplainer } = require('./explainer-weather.cjs');
const { newsExplainer } = require('./explainer-news.cjs');
const { makePortCongestionExplainer } = require('./explainer-port-congestion.cjs');
const { makeCrossVesselExplainer } = require('./explainer-cross-vessel.cjs');
const { fetchMeteoalarmAll, makeMeteoalarmExplainer } = require('./explainer-meteoalarm.cjs');
const { assemblePortContext } = require('./port-context.cjs');

const { ports: ALL_PORTS } = require('../src/config/maritime-ports.data.json');

// ---------------------------------------------------------------- config ----
const num = (name, def, min) => Math.max(min ?? -Infinity, Number(process.env[name]) || def);

const CONFIG = {
  port: num('PORT', 3004, 1),
  secret: process.env.RELAY_SHARED_SECRET || '',
  authHeader: (process.env.RELAY_AUTH_HEADER || 'x-relay-key').toLowerCase(),
  allowUnauthenticated: process.env.ALLOW_UNAUTHENTICATED_RELAY === '1',
  aisstreamKey: process.env.AISSTREAM_API_KEY || '',
  marinesiaKey: process.env.MARINESIA_API_KEY || '',
  marinesiaPollMs: num('MARINESIA_POLL_MS', 13_000, 12_000),
  aisFrameStaleMs: num('AIS_FRAME_STALE_MS', 120_000, 10_000),
  delayTickMs: num('FERRY_DELAY_INTERVAL_MS', 60_000, 10_000),
  geofenceTickMs: num('GEOFENCE_TICK_MS', 60_000, 10_000),
  portSnapshotMs: num('PORT_SNAPSHOT_MS', 5 * 60_000, 60_000),
  disruptionRefreshMs: num('DISRUPTION_REFRESH_MS', 3 * 60 * 60_000, 10 * 60_000),
  meteoalarmRefreshMs: num('METEOALARM_REFRESH_MS', 30 * 60_000, 5 * 60_000),
  portContextMs: num('PORT_CONTEXT_INTERVAL_MS', 10 * 60_000, 60_000),
  enrichMs: num('ENRICH_INTERVAL_MS', 5 * 60_000, 30_000),
  enrichTtlMs: num('ENRICH_TTL_MS', 30 * 60_000, 60_000),
  upstashUrl: process.env.UPSTASH_REDIS_REST_URL || '',
  upstashToken: process.env.UPSTASH_REDIS_REST_TOKEN || '',
};
// A tile is fresh for one full sweep + backoff margin (never below the shared default).
const MARINESIA_STALE_MS = Math.max(DEFAULT_STALE_MS, MARINESIA_TILES.length * CONFIG.marinesiaPollMs + 90_000);

const COMMERCIAL = ALL_PORTS.filter((p) => p.commercial);
const PORT_META = new Map(ALL_PORTS.map((p) => [p.id, p]));
const PORT_TZ = new Map(ALL_PORTS.map((p) => [p.id, db.tzForCountry(p.country)]));

// ----------------------------------------------------------------- state ----
function makeState() {
  return {
    store: makeVesselStore(),
    startedAt: Date.now(),
    // ingest
    lastAisFrameAt: 0,
    aisMessages: 0,
    marinesia: { tileIndex: 0, lastPollAt: null, lastError: null, tilesSeen: new Set(), tileLastOkAt: new Map(), upserts: 0 },
    // per-vessel delay/voyage tracking (freight with a resolved destination)
    etaHistory: new Map(),   // mmsi -> snapshots ring (eta-history)
    delayByMmsi: new Map(),  // mmsi -> drift verdict
    etaInfoByMmsi: new Map(),// mmsi -> {etaTs, etaDeltaMin, etaWindowMin, etaVsDepartureMin, voyageAgeMin}
    voyageByMmsi: new Map(), // mmsi -> voyage anchor
    reasonsByMmsi: new Map(),// mmsi -> {reasons, ts}
    // port status + history
    portStatusHistory: new Map(),   // smoothing rings for /ais/ports
    portSnapshotHistory: new Map(), // smoothing rings for the persisted snapshots
    portHistory: { membership: new Map(), enterTimes: new Map(), snapshots: [], events: [], lastSnapshotAt: 0 },
    baselines: new Map(),
    // context + disruptions
    meteoalarmWarnings: [],
    portContext: new Map(),  // portId -> {context, ts}
    disruptions: { events: [], refreshedAt: null },
    timers: [],
  };
}

// ---------------------------------------------------------------- ingest ----
function startAisstream(state) {
  if (!CONFIG.aisstreamKey) return console.warn('[relay] AISSTREAM_API_KEY not set — stream ingest disabled');
  const WebSocket = require('ws');
  let backoffMs = 1_000;
  const connect = () => {
    const ws = new WebSocket('wss://stream.aisstream.io/v0/stream');
    ws.on('open', () => {
      backoffMs = 1_000;
      ws.send(JSON.stringify({
        APIKey: CONFIG.aisstreamKey,
        BoundingBoxes: [[[-90, -180], [90, 180]]],
        FilterMessageTypes: ['PositionReport', 'ShipStaticData'],
      }));
      console.log('[relay] aisstream connected');
    });
    ws.on('message', (buf) => {
      state.lastAisFrameAt = Date.now();
      state.aisMessages++;
      let msg; try { msg = JSON.parse(buf.toString()); } catch { return; }
      const meta = msg.MetaData || {};
      const mmsi = meta.MMSI != null ? String(meta.MMSI) : null;
      if (!mmsi) return;
      if (msg.MessageType === 'PositionReport') {
        const p = msg.Message?.PositionReport || {};
        state.store.applyPosition({
          mmsi, name: String(meta.ShipName || '').trim(),
          lat: meta.latitude, lon: meta.longitude,
          speed: p.Sog, course: p.Cog, heading: p.TrueHeading,
          navStatus: p.NavigationalStatus,
        });
      } else if (msg.MessageType === 'ShipStaticData') {
        const s = msg.Message?.ShipStaticData || {};
        state.store.applyStatic({
          mmsi, name: String(meta.ShipName || s.Name || '').trim(),
          imo: s.ImoNumber ? String(s.ImoNumber) : '',
          shipType: s.Type, destination: String(s.Destination || '').trim(),
          etaAis: s.Eta ? `${s.Eta.Month}-${s.Eta.Day} ${s.Eta.Hour}:${s.Eta.Minute}` : '',
          draught: s.MaximumStaticDraught,
          length: (Number(s.Dimension?.A) || 0) + (Number(s.Dimension?.B) || 0),
          beam: (Number(s.Dimension?.C) || 0) + (Number(s.Dimension?.D) || 0),
        });
      }
    });
    const retry = () => {
      backoffMs = Math.min(backoffMs * 2, 60_000);
      setTimeout(connect, backoffMs).unref?.();
    };
    ws.on('close', retry);
    ws.on('error', (e) => { console.warn('[relay] aisstream error:', e.message); ws.terminate(); });
  };
  connect();
}

async function marinesiaTick(state) {
  if (!CONFIG.marinesiaKey) return;
  const m = state.marinesia;
  const idx = m.tileIndex % MARINESIA_TILES.length;
  m.tileIndex++;
  try {
    const rows = await fetchTile(MARINESIA_TILES[idx], CONFIG.marinesiaKey);
    const now = Date.now();
    for (const raw of rows) {
      const v = normalizeMarinesiaVessel(raw, now);
      if (v) { state.store.applyFull(v, now); m.upserts++; }
    }
    m.lastPollAt = now;
    m.lastError = null;
    m.tilesSeen.add(idx);
    m.tileLastOkAt.set(idx, Date.now());
    if (rows.length >= VESSEL_CAP) console.warn(`[relay] marinesia tile ${idx} at the ${VESSEL_CAP} cap — likely truncated, consider subdividing`);
  } catch (e) {
    m.lastError = e.message;
  }
}

// ------------------------------------------------------------- coverage ----
function feedFreshness(state, now = Date.now()) {
  if (!CONFIG.marinesiaKey) return {};
  const m = state.marinesia;
  return relayFreshness({ lastPollAt: m.lastPollAt, tilesSeen: m.tilesSeen.size, tileCount: MARINESIA_TILES.length, now, staleMs: MARINESIA_STALE_MS });
}
function aisstreamFresh(state, now = Date.now()) {
  return state.lastAisFrameAt > 0 && now - state.lastAisFrameAt <= CONFIG.aisFrameStaleMs;
}
function marinesiaFresh(state, now = Date.now()) {
  if (!CONFIG.marinesiaKey) return false;
  const f = feedFreshness(state, now);
  return !f.stale && !f.warming;
}
function marinesiaTileFresh(state, lat, lon, now = Date.now()) {
  const idx = tileIndexFor(MARINESIA_TILES, lat, lon);
  return idx >= 0 && tileFreshness({ lastOkAt: state.marinesia.tileLastOkAt.get(idx), now, staleMs: MARINESIA_STALE_MS });
}
/** Which feed sees this coordinate right now. coverageOk=false = an honest blind spot. */
function portFeed(state, lat, lon, aisFresh, marinesiaOk, now = Date.now()) {
  if (aisFresh) return { source: 'aisstream', coverageOk: true };
  const inRegion = tileIndexFor(MARINESIA_TILES, lat, lon) >= 0;
  if (marinesiaOk && inRegion && marinesiaTileFresh(state, lat, lon, now)) return { source: 'marinesia', coverageOk: true };
  return { source: inRegion ? 'marinesia' : 'aisstream', coverageOk: false };
}

// Port-local dow/hour for the baseline lookup (cached Intl formatters).
const _dtf = new Map();
function portLocalDowHour(now, tz) {
  const z = tz || 'UTC';
  let fmt = _dtf.get(z);
  if (!fmt) { fmt = new Intl.DateTimeFormat('en-US', { timeZone: z, weekday: 'short', hour: '2-digit', hour12: false }); _dtf.set(z, fmt); }
  const parts = fmt.formatToParts(new Date(now));
  const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.find((p) => p.type === 'weekday')?.value);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value) % 24;
  return { dow: dow < 0 ? 0 : dow, hour: Number.isFinite(hour) ? hour : 0 };
}

// -------------------------------------------------------- upstash (voyages) ----
async function upstashCmd(cmd) {
  if (!CONFIG.upstashUrl || !CONFIG.upstashToken) return null;
  const res = await fetch(CONFIG.upstashUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${CONFIG.upstashToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
  });
  if (!res.ok) throw new Error(`upstash ${res.status}`);
  return (await res.json()).result;
}
const VOYAGE_KEY = (day) => `relay:voyages:count:${day}`;
const utcDay = (ts) => new Date(ts).toISOString().slice(0, 10);
async function registerTrips(n, now = Date.now()) {
  if (!n) return;
  try {
    await upstashCmd(['INCRBY', VOYAGE_KEY(utcDay(now)), String(n)]);
    await upstashCmd(['EXPIRE', VOYAGE_KEY(utcDay(now)), String(120 * 24 * 3600)]);
  } catch (e) { console.warn('[relay] voyage count failed:', e.message); }
}

// ----------------------------------------------------------------- ticks ----
/** Live ETA + drift + voyage anchor for every freight vessel with a resolved destination. */
function delayTick(state, now = Date.now()) {
  let newTrips = 0;
  for (const v of state.store.freightList(now)) {
    const port = resolveDestinationPort(v.destination);
    if (!port) {
      state.etaHistory.delete(v.mmsi); state.delayByMmsi.delete(v.mmsi);
      state.etaInfoByMmsi.delete(v.mmsi); state.voyageByMmsi.delete(v.mmsi);
      continue;
    }
    const eta = etaFor({ lat: v.lat, lon: v.lon, speedKnots: v.speed }, port, now);
    const buf = recordSnapshot(state.etaHistory.get(v.mmsi) || [], {
      ts: now, etaTs: eta ? eta.etaTs : null, destPortId: port.portId,
      speed: Number.isFinite(v.speed) ? v.speed : 0,
    });
    state.etaHistory.set(v.mmsi, buf);
    const drift = detectDrift(buf);
    if (drift && (drift.slipping || drift.stalled)) state.delayByMmsi.set(v.mmsi, drift);
    else state.delayByMmsi.delete(v.mmsi);

    const prev = state.voyageByMmsi.get(v.mmsi);
    const voyage = updateVoyage(prev, { destPortId: port.portId, etaTs: eta ? eta.etaTs : null, now });
    if (voyage) {
      if (!prev || prev.destPortId !== voyage.destPortId) newTrips++;
      state.voyageByMmsi.set(v.mmsi, voyage);
    } else state.voyageByMmsi.delete(v.mmsi);

    const info = { etaTs: eta ? eta.etaTs : null };
    if (drift && Number.isFinite(drift.etaGrowthMin) && drift.windowMin > 0) {
      info.etaDeltaMin = drift.etaGrowthMin;
      info.etaWindowMin = drift.windowMin;
    }
    if (eta && voyage && Number.isFinite(voyage.departureEtaTs)) {
      info.etaVsDepartureMin = Math.round((eta.etaTs - voyage.departureEtaTs) / 60_000);
      info.voyageAgeMin = Math.round((now - voyage.startTs) / 60_000);
    }
    state.etaInfoByMmsi.set(v.mmsi, info);
  }
  if (newTrips) void registerTrips(newTrips, now);
  state.store.prune(now);
}

function computePorts(state, history, now = Date.now()) {
  const fresh = state.store.freightList(now, PORT_DEFAULTS.freshMs);
  const ports = computeAllPortStatus(ALL_PORTS, fresh, resolveDestinationPort, now, {}, (p) => p.commercial);
  smoothPortStatus(ports, history);
  const aisFresh = aisstreamFresh(state, now);
  const marinesiaOk = aisFresh ? false : marinesiaFresh(state, now);
  for (const p of ports) {
    const { dow, hour } = portLocalDowHour(now, PORT_TZ.get(p.portId));
    p.congestionRel = db.relativeCongestion(state.baselines, p.portId, p.atBerth, dow, hour);
    const pc = state.portContext.get(p.portId);
    if (pc && pc.context.length) { p.context = pc.context; p.contextAsOf = pc.ts; }
    const fp = portFeed(state, p.lat, p.lon, aisFresh, marinesiaOk, now);
    p.source = fp.source;
    p.coverageOk = fp.coverageOk;
  }
  const rank = { congested: 2, busy: 1, clear: 0 };
  ports.sort((a, b) => (rank[b.congestion] - rank[a.congestion]) || (b.atPort - a.atPort) || (b.inbound - a.inbound));
  return ports;
}

const GEOFENCES = buildPortGeofences(COMMERCIAL);
const HISTORY_MAX_SNAPSHOTS = 288; // 24h at 5-min cadence
const HISTORY_MAX_EVENTS = 2000;

function geofenceTick(state, now = Date.now()) {
  const fresh = state.store.freightList(now, PORT_DEFAULTS.freshMs);
  const aisFresh = aisstreamFresh(state, now);
  const marinesiaOk = aisFresh ? false : marinesiaFresh(state, now);
  // Freeze zones with no live coverage this tick: a dark feed must not fire phantom exits.
  const covered = GEOFENCES.filter((gf) => portFeed(state, gf.geometry.center.lat, gf.geometry.center.lon, aisFresh, marinesiaOk, now).coverageOk);
  const nextCovered = computeMembership(fresh, covered);
  const next = new Map(state.portHistory.membership);
  for (const gf of covered) next.set(gf.id, nextCovered.get(gf.id) || new Set());
  const events = diffMembership(state.portHistory.membership, next, now, state.portHistory.enterTimes, covered);
  state.portHistory.membership = next;
  if (events.length) {
    if (db.enabled) void db.writeEvents(events, { source: aisFresh ? 'aisstream' : 'marinesia' });
    else {
      state.portHistory.events.push(...events);
      if (state.portHistory.events.length > HISTORY_MAX_EVENTS) state.portHistory.events.splice(0, state.portHistory.events.length - HISTORY_MAX_EVENTS);
    }
  }
  if (now - state.portHistory.lastSnapshotAt >= CONFIG.portSnapshotMs) {
    const ports = computePorts(state, state.portSnapshotHistory, now);
    if (db.enabled) {
      void db.writeSnapshot(now, ports, { source: aisFresh ? 'aisstream' : 'marinesia' }).then((ok) => {
        if (ok) state.portHistory.lastSnapshotAt = now;
      });
    } else {
      state.portHistory.snapshots.push({ ts: now, ports: ports.map(({ name, lat, lon, region, ...dyn }) => dyn) });
      if (state.portHistory.snapshots.length > HISTORY_MAX_SNAPSHOTS) state.portHistory.snapshots.shift();
      state.portHistory.lastSnapshotAt = now;
    }
  }
}

async function disruptionsRefresh(state) {
  const countries = Object.keys(COUNTRY_SOURCES);
  const settled = await Promise.allSettled([
    fetchMitStrikes(),
    ...countries.map((c) => fetchGdeltStrikes(c)),
    ...countries.map((c) => fetchUnionStrikes(c)),
    fetchWaterLevelEvents(),
    fetchChokepointEvents(),
  ]);
  const batches = settled.filter((s) => s.status === 'fulfilled').map((s) => s.value).filter(Array.isArray);
  state.disruptions = { events: mergeDisruptionEvents(batches.flat()), refreshedAt: Date.now() };
  if (db.enabled) void db.logDisruptionsFirstSeen(state.disruptions.events);
}

async function meteoalarmRefresh(state) {
  try { state.meteoalarmWarnings = await fetchMeteoalarmAll(); }
  catch (e) { console.warn('[relay] meteoalarm refresh failed:', e.message); }
}

async function portContextRefresh(state, now = Date.now()) {
  const ports = computePorts(state, new Map(), now);
  for (const p of ports) {
    if (p.congestion === 'clear') { state.portContext.delete(p.portId); continue; }
    const meta = PORT_META.get(p.portId);
    try {
      const context = await assemblePortContext({
        port: { id: p.portId, name: p.name, lat: p.lat, lon: p.lon, region: meta?.region, country: meta?.country },
        warnings: state.meteoalarmWarnings,
        strikeEvents: state.disruptions.events,
        congestionRel: p.congestionRel,
      });
      if (context && context.length) state.portContext.set(p.portId, { context, ts: now });
    } catch { /* context is best-effort */ }
  }
}

function makeDelayExplainers(state) {
  const getFerryVessels = () => state.store.freightList().map((v) => ({
    ...v,
    delayed: state.delayByMmsi.has(v.mmsi),
  }));
  return [
    weatherExplainer,
    newsExplainer,
    makeMeteoalarmExplainer(() => state.meteoalarmWarnings),
    makePortCongestionExplainer(getFerryVessels),
    makeCrossVesselExplainer(getFerryVessels),
  ];
}

async function enrichTick(state, explainers, now = Date.now()) {
  const due = [];
  for (const mmsi of state.delayByMmsi.keys()) {
    const cached = state.reasonsByMmsi.get(mmsi);
    if (!cached || now - cached.ts > CONFIG.enrichTtlMs) due.push(mmsi);
    if (due.length >= 5) break;
  }
  for (const mmsi of due) {
    const v = state.store.positions.get(mmsi);
    const drift = state.delayByMmsi.get(mmsi);
    if (!v || !drift) continue;
    const stat = state.store.statics.get(mmsi);
    const port = resolveDestinationPort(stat?.destination);
    const meta = port ? PORT_META.get(port.portId) : null;
    const ctx = {
      mmsi, lat: v.lat, lon: v.lon,
      destPortId: port?.portId, destName: port?.name, destLat: port?.lat, destLon: port?.lon,
      destRegion: port?.region, destCountry: meta?.country,
      operatorName: resolveOperatorName(v.name || stat?.name),
      etaGrowthMin: drift.etaGrowthMin, stalled: drift.stalled,
    };
    try {
      state.reasonsByMmsi.set(mmsi, { reasons: await runExplainers(explainers, ctx), ts: now });
    } catch (e) { console.warn('[relay] enrich failed:', e.message); }
  }
  for (const mmsi of state.reasonsByMmsi.keys()) {
    if (!state.delayByMmsi.has(mmsi)) state.reasonsByMmsi.delete(mmsi);
  }
}

// ---------------------------------------------------------------- routes ----
function decorateVessel(state, v) {
  const info = state.etaInfoByMmsi.get(v.mmsi);
  if (info && Number.isFinite(info.etaTs)) {
    v.etaTs = info.etaTs;
    if (Number.isFinite(info.etaDeltaMin)) { v.etaDeltaMin = info.etaDeltaMin; v.etaWindowMin = info.etaWindowMin; }
    if (Number.isFinite(info.etaVsDepartureMin)) { v.etaVsDepartureMin = info.etaVsDepartureMin; v.voyageAgeMin = info.voyageAgeMin; }
  }
  const drift = state.delayByMmsi.get(v.mmsi);
  if (drift) {
    v.delay = {
      slipping: !!drift.slipping, stalled: !!drift.stalled, etaGrowthMin: drift.etaGrowthMin,
      reasons: state.reasonsByMmsi.get(v.mmsi)?.reasons || [],
    };
  }
  return v;
}

function buildRoutes(state) {
  const CACHE = { short: { 'Cache-Control': 'public, max-age=5', 'CDN-Cache-Control': 'public, max-age=10' },
    ports: { 'Cache-Control': 'public, max-age=15', 'CDN-Cache-Control': 'public, max-age=30' },
    static: { 'Cache-Control': 'public, max-age=300, s-maxage=300' },
    db: { 'Cache-Control': 'public, max-age=300, s-maxage=600' },
    profile: { 'Cache-Control': 'public, max-age=60, s-maxage=120' } };
  const dbless = () => ({ found: false, db: false, generatedAt: Date.now() });

  return [
    { match: (p) => p === '/' || p === '/health', public: true, handler: (req, res) => {
      const m = state.marinesia;
      sendJson(req, res, 200, { 'Cache-Control': 'no-store' }, {
        status: 'ok',
        uptimeSec: Math.round((Date.now() - state.startedAt) / 1000),
        messages: state.aisMessages,
        connected: aisstreamFresh(state),
        tracked: state.store.positions.size,
        marinesia: {
          enabled: !!CONFIG.marinesiaKey,
          tiles: MARINESIA_TILES.length,
          lastPollAt: m.lastPollAt ? new Date(m.lastPollAt).toISOString() : null,
          lastError: m.lastError,
          tileAgesSec: MARINESIA_TILES.map((_, i) => (m.tileLastOkAt.has(i) ? Math.round((Date.now() - m.tileLastOkAt.get(i)) / 1000) : null)),
        },
        delays: { flagged: state.delayByMmsi.size },
        db: db.enabled,
        disruptions: { count: state.disruptions.events.length, refreshedAt: state.disruptions.refreshedAt },
      });
    } },

    { match: (p) => p === '/metrics', handler: (req, res) => {
      sendJson(req, res, 200, { 'Cache-Control': 'no-store' }, {
        generatedAt: new Date().toISOString(),
        ais: { messages: state.aisMessages, tracked: state.store.positions.size, connected: aisstreamFresh(state) },
        marinesia: { upserts: state.marinesia.upserts, tilesSeen: state.marinesia.tilesSeen.size, tiles: MARINESIA_TILES.length },
        delays: { flagged: state.delayByMmsi.size, withReasons: state.reasonsByMmsi.size },
        portHistory: { snapshots: state.portHistory.snapshots.length, events: state.portHistory.events.length },
      });
    } },

    { match: (p) => p === '/ais/vessels', handler: (req, res, url) => {
      const q = url.searchParams;
      const wantOperator = (q.get('operator') || '').toLowerCase() || undefined;
      const list = buildVesselList(state.store.positions, state.store.statics, {
        bounds: parseBbox(q.get('bbox')),
        wantTypes: parseTypes(q.get('types')),
        limit: clampLimit(q.get('limit'), { def: 500, max: 5000 }), // assistant pulls up to 3000
        isFreight: q.get('freight') === '1' ? isFreightVessel : null, // predicate, not a flag
        resolveOperator,
        wantOperator,
      }).map((v) => decorateVessel(state, v));
      sendJson(req, res, 200, CACHE.short, {
        vessels: list, count: list.length, tracked: state.store.positions.size,
        bbox: state.store.boundingBox(), generatedAt: Date.now(), ...feedFreshness(state),
      });
    } },

    { match: (p) => p === '/ais/ports', handler: (req, res) => {
      const ports = computePorts(state, state.portStatusHistory);
      sendJson(req, res, 200, CACHE.ports, {
        ports, count: ports.length,
        freightTracked: state.store.freightList().length,
        generatedAt: Date.now(),
        uncoveredPorts: ports.filter((p) => !p.coverageOk).map((p) => p.portId),
        ...feedFreshness(state),
      });
    } },

    { match: (p) => p === '/ais/geofences', handler: (req, res) => {
      sendJson(req, res, 200, CACHE.static, { geofences: GEOFENCES, count: GEOFENCES.length, generatedAt: Date.now() });
    } },

    { match: (p) => p === '/ais/port-history', handler: async (req, res, url) => {
      if (db.enabled) {
        const hours = Math.min(Math.max(Number(url.searchParams.get('hours')) || 24, 1), 24 * 14);
        // queryPortHistory takes sinceMs, not hours — passing {hours} silently widens to its default window.
        return sendJson(req, res, 200, CACHE.profile, await db.queryPortHistory({ sinceMs: Date.now() - hours * 3600_000 }));
      }
      sendJson(req, res, 200, CACHE.profile, {
        snapshots: state.portHistory.snapshots, events: state.portHistory.events, db: false, generatedAt: Date.now(),
      });
    } },

    { match: (p) => p === '/ais/port-series', handler: async (req, res, url) => {
      if (!db.enabled) return sendJson(req, res, 200, CACHE.profile, { ts: [], ports: {}, fields: [], hours: 0, tickCount: 0, portCount: 0, generatedAt: Date.now(), db: false });
      const port = url.searchParams.get('port');
      sendJson(req, res, 200, CACHE.profile, await db.queryPortSeries({
        ports: port ? [port.toLowerCase()] : undefined, // plural — singular is silently ignored
        hours: Number(url.searchParams.get('hours')) || undefined,
      }));
    } },

    { match: (p) => p === '/ais/voyages/daily', handler: async (req, res, url) => {
      const days = Math.min(Math.max(Number(url.searchParams.get('days')) || 14, 1), 120);
      const dates = Array.from({ length: days }, (_, i) => utcDay(Date.now() - i * 24 * 3600 * 1000));
      // One MGET, not N serial GETs — 120 awaited round-trips took seconds per request.
      let counts = [];
      try { counts = (await upstashCmd(['MGET', ...dates.map(VOYAGE_KEY)])) || []; } catch { /* no store -> zeros */ }
      const daily = dates.map((date, i) => ({ date, trips: Number(counts[i]) || 0 }));
      const total = daily.reduce((n, d) => n + d.trips, 0);
      sendJson(req, res, 200, CACHE.db, { daily, totalTrips: total, days, generatedAt: Date.now() });
    } },

    { match: (p) => p === '/ais/trip', handler: async (req, res, url) => {
      sendJson(req, res, 200, CACHE.db, db.enabled ? await db.queryTrip({ id: url.searchParams.get('id') || undefined }) : dbless());
    } },

    { match: (p) => p === '/ais/vessel-profile', handler: async (req, res, url) => {
      sendJson(req, res, 200, CACHE.db, db.enabled ? await db.queryVesselProfile({ mmsi: url.searchParams.get('mmsi') || undefined }) : dbless());
    } },

    { match: (p) => p === '/ais/port-profile', handler: async (req, res, url) => {
      const payload = db.enabled ? await db.queryPortProfile({ port: url.searchParams.get('port') || undefined }) : dbless();
      if (payload.found) {
        const pc = state.portContext.get(String(url.searchParams.get('port') || '').trim().toLowerCase());
        payload.context = pc ? pc.context : [];
        if (pc) payload.contextAsOf = pc.ts;
      }
      sendJson(req, res, 200, CACHE.profile, payload);
    } },

    { match: (p) => p === '/ais/disruptions', handler: (req, res, url) => {
      const wantCountry = (url.searchParams.get('country') || '').toUpperCase() || null;
      const wantPort = (url.searchParams.get('port') || '').trim().toLowerCase() || null;
      let events = state.disruptions.events;
      if (wantCountry) events = events.filter((e) => e.country === wantCountry);
      if (wantPort) {
        const meta = PORT_META.get(wantPort);
        events = meta
          ? events.filter((e) => strikeReasonForPort([e], { country: meta.country, region: meta.region, portName: meta.name }) != null)
          : [];
      }
      sendJson(req, res, 200, CACHE.db, { events, count: events.length, refreshedAt: state.disruptions.refreshedAt, generatedAt: Date.now() });
    } },
  ];
}

// ----------------------------------------------------------------- wiring ----
function createRelay({ startIngest = true, startJobs = true } = {}) {
  const state = makeState();
  const handler = makeHandler({
    routes: buildRoutes(state),
    secret: CONFIG.secret,
    authHeader: CONFIG.authHeader,
    allowUnauthenticated: CONFIG.allowUnauthenticated || !CONFIG.secret,
    rateLimit: { windowMs: Number(process.env.RELAY_RATE_LIMIT_WINDOW_MS) || 60_000, max: Number(process.env.RELAY_RATE_LIMIT_MAX) || 300 },
  });
  const server = http.createServer(handler);

  const every = (fn, ms) => { const t = setInterval(fn, ms); t.unref?.(); state.timers.push(t); };
  const bootAnd = (fn, ms) => { void fn(); every(fn, ms); };

  if (startIngest) {
    startAisstream(state);
    if (CONFIG.marinesiaKey) {
      every(() => void marinesiaTick(state), CONFIG.marinesiaPollMs);
      console.log(`[relay] marinesia: ${MARINESIA_TILES.length} tiles, ~${Math.round(MARINESIA_TILES.length * CONFIG.marinesiaPollMs / 1000)}s/sweep`);
    }
  }
  if (startJobs) {
    const explainers = makeDelayExplainers(state);
    every(() => delayTick(state), CONFIG.delayTickMs);
    every(() => geofenceTick(state), CONFIG.geofenceTickMs);
    every(() => void enrichTick(state, explainers), CONFIG.enrichMs);
    bootAnd(() => void disruptionsRefresh(state), CONFIG.disruptionRefreshMs);
    bootAnd(() => void meteoalarmRefresh(state), CONFIG.meteoalarmRefreshMs);
    every(() => void portContextRefresh(state), CONFIG.portContextMs);
    if (db.enabled) {
      bootAnd(async () => { await db.refreshBaselines(); state.baselines = await db.loadBaselines(); }, 24 * 3600 * 1000);
      void db.syncPorts(ALL_PORTS);
    }
  }

  const stop = () => { for (const t of state.timers) clearInterval(t); server.close(); };
  return { server, handler, state, stop };
}

function main() {
  const relay = createRelay();
  relay.server.listen(CONFIG.port, () => {
    console.log(`[relay] freight relay listening on :${CONFIG.port} (db=${db.enabled ? 'on' : 'off'}, auth=${CONFIG.secret ? 'on' : 'OFF'})`);
  });
}

if (require.main === module) main();

module.exports = { createRelay, CONFIG, portFeed, portLocalDowHour };
