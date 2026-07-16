// Postgres sink for the port-congestion time-series (Neon serverless HTTP driver). Owns the
// durable, query-able history that replaces the Upstash single-blob port-history (which capped
// ~1 MB / ~1 day and lost data on restart). Spec: assistant/PORT_CONGESTION_SCHEMA.md.
//
// Fail-soft: with no DATABASE_URL (or the dep absent) `enabled` is false and every write/sync is a
// no-op, so the relay runs exactly as before. HTTP-per-query fits the relay's fire-and-forget tick.
'use strict';

let neon = null;
try { ({ neon } = require('@neondatabase/serverless')); } catch { /* dep not installed */ }

const DATABASE_URL = process.env.DATABASE_URL || '';
const enabled = !!(DATABASE_URL && neon);
const sql = enabled ? neon(DATABASE_URL) : null;

// country → IANA tz. All four covered countries are single-zone for our ports; the baseline is
// bucketed in local port time (congestion follows local working hours), so tz must be accurate.
const COUNTRY_TZ = { IT: 'Europe/Rome', GB: 'Europe/London', ES: 'Europe/Madrid', NL: 'Europe/Amsterdam' };
// Single source for the country→tz derivation (used by syncPorts on write AND the relay's PORT_TZ on
// read — they must agree or the baseline's write/read bucket keys diverge). IT is the no-`country` default.
const tzForCountry = (country) => COUNTRY_TZ[country || 'IT'] || 'Europe/Rome';

// In-memory counters read synchronously by /health (never do an async PG call in the health path).
const stats = {
  enabled, portsSynced: 0, snapshotRows: 0, eventRows: 0, lastWriteAt: null, lastWriteOk: null, lastError: null,
  baselineBuckets: 0, baselineRefreshedAt: null, vesselsSynced: 0, vesselsSyncedAt: null,
  // Trips writer (Phase B) — SEPARATE health from the port-history writer above, so a trip-write
  // failure never flips the snapshot writer's lastWriteOk (and vice versa). Driven by tripOk/tripFail.
  tripsOpened: 0, tripsArrived: 0, tripsAbandoned: 0, tripPointRows: 0, tripPointsDropped: 0,
  lastTripWriteAt: null, lastTripWriteOk: null, lastTripError: null,
};
function ok(kind, n) { stats.lastWriteAt = Date.now(); stats.lastWriteOk = true; if (kind) stats[kind] += n; }
function fail(e) { stats.lastWriteAt = Date.now(); stats.lastWriteOk = false; stats.lastError = String(e && e.message || e).slice(0, 200); }
function tripOk(kind, n) { stats.lastTripWriteAt = Date.now(); stats.lastTripWriteOk = true; if (kind) stats[kind] += n; }
function tripFail(e) { stats.lastTripWriteAt = Date.now(); stats.lastTripWriteOk = false; stats.lastTripError = String(e && e.message || e).slice(0, 200); }

// The neon HTTP driver has no built-in timeout; bound each write so a hung endpoint can't stall the
// sampler's in-flight guard (or leak a hung fetch on the fire-and-forget event path).
const WRITE_TIMEOUT_MS = 10_000;
function withTimeout(promise, ms = WRITE_TIMEOUT_MS) {
  let t;
  const timeout = new Promise((_, rej) => { t = setTimeout(() => rej(new Error('pg write timeout')), ms); t.unref?.(); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t)); // don't leave the timer pending on success
}

/** Upsert the commercial ports dimension (idempotent) with tz derived per country. Boot-only. */
async function syncPorts(portsById) {
  if (!enabled) return;
  const ports = (Array.isArray(portsById) ? portsById : Object.values(portsById || {}))
    .filter((p) => p && p.commercial && Number.isFinite(p.lat) && Number.isFinite(p.lon));
  try {
    await sql`
      INSERT INTO ports (port_id, name, country, region, lat, lon, tz)
      SELECT * FROM unnest(
        ${ports.map((p) => p.id)}::text[], ${ports.map((p) => p.name)}::text[],
        ${ports.map((p) => p.country || 'IT')}::text[], ${ports.map((p) => p.region || null)}::text[],
        ${ports.map((p) => p.lat)}::float8[], ${ports.map((p) => p.lon)}::float8[],
        ${ports.map((p) => tzForCountry(p.country))}::text[]
      )
      ON CONFLICT (port_id) DO UPDATE SET
        name=EXCLUDED.name, country=EXCLUDED.country, region=EXCLUDED.region,
        lat=EXCLUDED.lat, lon=EXCLUDED.lon, tz=EXCLUDED.tz`;
    stats.portsSynced = ports.length;
  } catch (e) { fail(e); throw e; }
}

/**
 * Upsert the vessel dimension (durable per-vessel profile). `first_seen` set once on insert;
 * `last_seen` + attributes update on conflict. COALESCE keeps a known imo/name/dimension from being
 * overwritten by a null on a position-only frame; classification fields always reflect the latest.
 * Each row: { mmsi, imo, name, shipType, category, isFreight, freightReason, operatorId, operatorName, length, beam, draught }.
 */
async function syncVessels(vessels) {
  if (!enabled || !vessels || !vessels.length) return 0;
  const now = new Date().toISOString();
  const s = (f) => vessels.map((v) => v[f] || null);
  const num = (f) => vessels.map((v) => (Number.isFinite(v[f]) ? v[f] : null));
  const bool = (f) => vessels.map((v) => !!v[f]);
  try {
    await withTimeout(sql`
      INSERT INTO vessels (mmsi, imo, name, ship_type, category, is_freight, freight_reason, operator_id, operator_name, length_m, beam_m, draught_m, first_seen, last_seen)
      SELECT u.mmsi, u.imo, u.name, u.ship_type, u.category, u.is_freight, u.freight_reason, u.operator_id, u.operator_name, u.length_m, u.beam_m, u.draught_m, ${now}::timestamptz, ${now}::timestamptz
      FROM unnest(
        ${s('mmsi')}::text[], ${s('imo')}::text[], ${s('name')}::text[], ${num('shipType')}::int[],
        ${s('category')}::text[], ${bool('isFreight')}::bool[], ${s('freightReason')}::text[],
        ${s('operatorId')}::text[], ${s('operatorName')}::text[], ${num('length')}::real[], ${num('beam')}::real[], ${num('draught')}::real[]
      ) AS u(mmsi, imo, name, ship_type, category, is_freight, freight_reason, operator_id, operator_name, length_m, beam_m, draught_m)
      ON CONFLICT (mmsi) DO UPDATE SET
        imo=COALESCE(EXCLUDED.imo, vessels.imo), name=COALESCE(EXCLUDED.name, vessels.name),
        ship_type=COALESCE(EXCLUDED.ship_type, vessels.ship_type), category=EXCLUDED.category,
        is_freight=EXCLUDED.is_freight, freight_reason=EXCLUDED.freight_reason,
        operator_id=COALESCE(EXCLUDED.operator_id, vessels.operator_id),
        operator_name=COALESCE(EXCLUDED.operator_name, vessels.operator_name),
        length_m=COALESCE(EXCLUDED.length_m, vessels.length_m), beam_m=COALESCE(EXCLUDED.beam_m, vessels.beam_m),
        draught_m=COALESCE(EXCLUDED.draught_m, vessels.draught_m), last_seen=EXCLUDED.last_seen`);
    stats.vesselsSynced = vessels.length;
    stats.vesselsSyncedAt = Date.now();
    return vessels.length;
  } catch (e) { fail(e); return 0; }
}

/**
 * Batch-insert one congestion snapshot (all ports for a tick). Returns true on success, false on
 * failure — the sampler advances its 5-min cadence ONLY on true, so a transient DB error retries
 * next tick instead of dropping the sample (a permanent baseline gap). `rows` = per-port entries;
 * each may carry its own source/coverageOk (P0.2), falling back to meta.* for callers that don't.
 */
async function writeSnapshot(tsMs, rows, meta = {}) {
  if (!enabled || !rows || !rows.length) return true; // nothing to write = success (don't block the cadence)
  const ts = new Date(tsMs).toISOString();
  const eta = (h) => rows.map((r) => (r.inboundEta && Number.isFinite(r.inboundEta[h]) ? r.inboundEta[h] : null));
  const col = (f) => rows.map((r) => (Number.isFinite(r[f]) ? r[f] : null));
  const src = rows.map((r) => r.source || meta.source || 'relay');
  const cov = rows.map((r) => r.coverageOk !== false); // per-row coverage (P0.2 stamps it); missing → true
  try {
    await withTimeout(sql`
      INSERT INTO port_snapshots
        (ts, port_id, at_port, at_port_raw, at_berth, at_anchor, inbound, eta_h6, eta_h12, eta_h24, eta_h48, feed_label, source, coverage_ok)
      SELECT ${ts}::timestamptz, u.port_id, u.at_port, u.at_port_raw, u.at_berth, u.at_anchor, u.inbound,
             u.eta_h6, u.eta_h12, u.eta_h24, u.eta_h48, u.feed_label, u.source, u.coverage_ok
      FROM unnest(
        ${rows.map((r) => r.portId)}::text[], ${col('atPort')}::int[], ${col('atPortRaw')}::int[],
        ${col('atBerth')}::int[], ${col('atAnchor')}::int[], ${col('inbound')}::int[],
        ${eta('h6')}::int[], ${eta('h12')}::int[], ${eta('h24')}::int[], ${eta('h48')}::int[],
        ${rows.map((r) => r.congestion || null)}::text[], ${src}::text[], ${cov}::bool[]
      ) AS u(port_id, at_port, at_port_raw, at_berth, at_anchor, inbound, eta_h6, eta_h12, eta_h24, eta_h48, feed_label, source, coverage_ok)
      ON CONFLICT (port_id, ts) DO UPDATE SET
        at_port=EXCLUDED.at_port, at_port_raw=EXCLUDED.at_port_raw, at_berth=EXCLUDED.at_berth,
        at_anchor=EXCLUDED.at_anchor, inbound=EXCLUDED.inbound, eta_h6=EXCLUDED.eta_h6,
        eta_h12=EXCLUDED.eta_h12, eta_h24=EXCLUDED.eta_h24, eta_h48=EXCLUDED.eta_h48,
        feed_label=EXCLUDED.feed_label, source=EXCLUDED.source, coverage_ok=EXCLUDED.coverage_ok`);
    ok('snapshotRows', rows.length);
    return true;
  } catch (e) { fail(e); return false; }
}

/** Batch-insert geofence enter/exit events (dwell_min on exit, nullable). */
async function writeEvents(events, meta = {}) {
  if (!enabled || !events || !events.length) return;
  try {
    await withTimeout(sql`
      INSERT INTO port_events (ts, port_id, mmsi, kind, dwell_min, source)
      SELECT to_timestamp(u.ts / 1000.0), u.port_id, u.mmsi, u.kind, u.dwell_min, ${meta.source || 'relay'}
      FROM unnest(
        ${events.map((e) => e.ts)}::bigint[], ${events.map((e) => e.portId)}::text[],
        ${events.map((e) => String(e.mmsi))}::text[], ${events.map((e) => e.kind)}::text[],
        ${events.map((e) => (Number.isFinite(e.dwellMin) ? e.dwellMin : null))}::real[]
      ) AS u(ts, port_id, mmsi, kind, dwell_min)`);
    ok('eventRows', events.length);
  } catch (e) { fail(e); }
}

// ---------------------------------------------------------------------------
// Trips lifecycle writer (Phase B). A trip = one freight vessel leg toward a destination port.
// IDENTITY is anchor-driven (opened when the relay's voyage anchor resolves a destination); geofence
// port_events only CLOSE (dest-enter) and DECORATE (origin/dwell backfill). Every mutation is
// status-guarded so any replay/interleave/restart is a 0-row no-op. Writes are fire-and-forget from
// the relay (never awaited in the geofence tick). Requires migration 003's uq_trips_one_open.
// ---------------------------------------------------------------------------
// epoch-ms columns are written as to_timestamp(${x}::float8 / 1000.0) — NULL-safe (a NULL param
// flows through as NULL) — since the neon template parameterizes values, not raw SQL fragments.

/**
 * Open a trip (idempotent). Returns the new bigserial id, or the incumbent open trip's id on
 * conflict, or null (disabled/failed). uq_trips_one_open (migration 003) makes the second open for a
 * vessel a no-op; the SELECT fallback returns the incumbent so the caller can bind to it.
 */
async function openTrip({ mmsi, originPortId = null, destPortId, openedAt, departedAt = null, departureEta = null }) {
  if (!enabled || !mmsi || !destPortId) return null;
  try {
    const rows = await withTimeout(sql`
      INSERT INTO trips (mmsi, origin_port_id, dest_port_id, opened_at, departed_at, departure_eta, eta_at_open, status, updated_at)
      VALUES (${String(mmsi)}, ${originPortId}, ${destPortId},
              to_timestamp(${openedAt}::float8 / 1000.0),
              to_timestamp(${departedAt}::float8 / 1000.0),
              to_timestamp(${departureEta}::float8 / 1000.0),
              ${Number.isFinite(departureEta)},
              'open', now())
      ON CONFLICT (mmsi) WHERE status = 'open' DO NOTHING
      RETURNING id`);
    let id = rows && rows[0] ? rows[0].id : null;
    if (id != null) { tripOk('tripsOpened', 1); return Number(id); }
    // Conflict: an open trip already exists — return the incumbent id so the caller rebinds to it.
    const inc = await withTimeout(sql`SELECT id FROM trips WHERE mmsi = ${String(mmsi)} AND status = 'open' LIMIT 1`);
    return inc && inc[0] ? Number(inc[0].id) : null;
  } catch (e) { tripFail(e); return null; }
}

/**
 * Close trips whose destination geofence was entered. `arrivals` = [{ mmsi, portId, ts(ms) }] (a
 * tick's enter events). The WHERE clause IS the join (mmsi + dest_port_id + status='open'), so a
 * jitter/double-enter updates 0 rows. Returns the count actually closed.
 */
async function finishTrip(arrivals) {
  if (!enabled || !arrivals || !arrivals.length) return 0;
  const mmsi = arrivals.map((a) => String(a.mmsi));
  const port = arrivals.map((a) => a.portId);
  const ts = arrivals.map((a) => new Date(a.ts).toISOString());
  try {
    const rows = await withTimeout(sql`
      UPDATE trips t SET
        arrived_at = u.ts, status = 'arrived',
        duration_min = round(extract(epoch from (u.ts - COALESCE(t.departed_at, t.opened_at))) / 60.0)::int,
        updated_at = now()
      FROM unnest(${mmsi}::text[], ${port}::text[], ${ts}::timestamptz[]) AS u(mmsi, port_id, ts)
      WHERE t.mmsi = u.mmsi AND t.dest_port_id = u.port_id AND t.status = 'open'
      RETURNING t.id`);
    const n = Array.isArray(rows) ? rows.length : 0;
    if (n) tripOk('tripsArrived', n);
    return n;
  } catch (e) { tripFail(e); return 0; }
}

/**
 * Append per-tick trip_points. `rows` = [{ tripId, ts(ms), lat, lon, speedKn, course, eta(ms|null),
 * etaSlipMin(int|null) }]. PK(trip_id,ts) + ON CONFLICT DO NOTHING → replay-safe.
 */
async function appendTripPoints(rows) {
  if (!enabled || !rows || !rows.length) return 0;
  const num = (f) => rows.map((r) => (Number.isFinite(r[f]) ? r[f] : null));
  try {
    await withTimeout(sql`
      INSERT INTO trip_points (trip_id, ts, lat, lon, speed_kn, course, eta, eta_slip_min)
      SELECT u.trip_id, to_timestamp(u.ts::float8 / 1000.0), u.lat, u.lon, u.speed_kn, u.course,
             CASE WHEN u.eta IS NOT NULL THEN to_timestamp(u.eta::float8 / 1000.0) END, u.eta_slip_min
      FROM unnest(
        ${rows.map((r) => r.tripId)}::bigint[], ${num('ts')}::bigint[], ${num('lat')}::float8[],
        ${num('lon')}::float8[], ${num('speedKn')}::real[], ${num('course')}::real[],
        ${num('eta')}::bigint[], ${num('etaSlipMin')}::int[]
      ) AS u(trip_id, ts, lat, lon, speed_kn, course, eta, eta_slip_min)
      ON CONFLICT (trip_id, ts) DO NOTHING`);
    tripOk('tripPointRows', rows.length);
    return rows.length;
  } catch (e) { tripFail(e); return 0; }
}

/**
 * Boot reconciliation: Postgres is authoritative for open/arrived trips. Returns
 * Map(mmsi → { tripId, destPortId, openedAt, departureEta, originPortId, departedAt, stalled, status }).
 * LIMIT 5000 is a leak alarm (the caller WARNs when hit); the daily sweep keeps the set bounded.
 */
async function loadOpenTrips() {
  if (!enabled) return { trips: new Map(), capped: false };
  const rows = await sql`
    SELECT id, mmsi, dest_port_id, origin_port_id, stalled, status,
           extract(epoch from opened_at) * 1000 AS opened_at,
           extract(epoch from departure_eta) * 1000 AS departure_eta,
           extract(epoch from departed_at) * 1000 AS departed_at
    FROM trips WHERE status IN ('open', 'arrived') ORDER BY opened_at DESC LIMIT 5000`;
  const m = new Map();
  for (const r of rows) {
    m.set(String(r.mmsi), {
      tripId: Number(r.id), destPortId: r.dest_port_id, originPortId: r.origin_port_id,
      openedAt: r.opened_at != null ? Number(r.opened_at) : null,
      departureEta: r.departure_eta != null ? Number(r.departure_eta) : null,
      departedAt: r.departed_at != null ? Number(r.departed_at) : null,
      stalled: !!r.stalled, status: r.status,
    });
  }
  return { trips: m, capped: rows.length >= 5000 };
}

/** Abandon specific open trips. Status-guarded. `reason` ('anchor_lost' | 'reroute') is stamped on
 * the row (migration 008) so abandonment is auditable by cause, not archaeology. */
async function abandonTrips(ids, reason = null) {
  if (!enabled || !ids || !ids.length) return 0;
  try {
    const rows = await withTimeout(sql`
      UPDATE trips SET status = 'abandoned', abandon_reason = ${reason}, updated_at = now()
      WHERE id = ANY(${ids.map(Number)}::bigint[]) AND status = 'open' RETURNING id`);
    const n = Array.isArray(rows) ? rows.length : 0;
    if (n) tripOk('tripsAbandoned', n);
    return n;
  } catch (e) { tripFail(e); return 0; }
}

/**
 * Backstop sweep: abandon open trips older than maxAgeH (never reached / dark / untracked dest).
 * Returns the ABANDONED trip IDS (not a count) so the caller can reconcile its in-memory state against
 * exactly what the DB changed — reconciling by a recomputed age cutoff instead would race the SQL
 * now() and could mark a trip the DB left open.
 */
async function abandonStaleTrips(maxAgeH = 120) {
  if (!enabled) return [];
  try {
    const rows = await withTimeout(sql`
      UPDATE trips SET status = 'abandoned', abandon_reason = 'max_open_age', updated_at = now()
      WHERE status = 'open' AND opened_at < now() - make_interval(hours => ${maxAgeH}) RETURNING id`);
    const ids = Array.isArray(rows) ? rows.map((r) => Number(r.id)) : [];
    if (ids.length) tripOk('tripsAbandoned', ids.length);
    return ids;
  } catch (e) { tripFail(e); return []; }
}

/** Mark a trip stalled (eager, first tick drift.stalled fires). Guarded so it writes at most once —
 * which also makes stalled_at the signal's FIRST firing, the anchor for lead-time stats
 * (arrived_at - stalled_at = how much warning the flag gave; migration 009). */
async function markStalled(tripId) {
  if (!enabled || tripId == null) return;
  try { await withTimeout(sql`UPDATE trips SET stalled = true, stalled_at = now(), updated_at = now() WHERE id = ${Number(tripId)} AND NOT stalled`); }
  catch (e) { tripFail(e); }
}

/** Backfill the leg's departure ETA once, when the anchor first gets a real ETA. */
async function patchTripEta(tripId, etaTs) {
  if (!enabled || tripId == null || !Number.isFinite(etaTs)) return;
  try { await withTimeout(sql`UPDATE trips SET departure_eta = to_timestamp(${etaTs}::float8 / 1000.0), updated_at = now() WHERE id = ${Number(tripId)} AND departure_eta IS NULL`); }
  catch (e) { tripFail(e); }
}

// The slip level at which a voyage counts as "flagged slipping". 30 min is the threshold the lead-time
// claim is built on (prod 2026-07-16: flagged voyages were >2h late 11x more often, 31.9% vs 2.9%);
// slip_flagged_at stamps the FIRST bump that reaches it. Changing this only affects future stamps —
// past stamps keep the threshold they were written under, so keep it stable once customer-facing.
const SLIP_FLAG_MIN = 30;

/** Raise a trip's worst ETA slip (delay magnitude). Guarded to a monotonic max. Stamps
 * slip_flagged_at exactly once, on the first bump that reaches SLIP_FLAG_MIN — the moment the
 * "flagged slipping" signal fired, so lead time (arrived_at - slip_flagged_at) is computable. */
async function bumpTripEtaSlip(tripId, slipMin) {
  if (!enabled || tripId == null || !Number.isFinite(slipMin)) return;
  const s = Math.round(slipMin);
  try {
    await withTimeout(sql`
      UPDATE trips SET max_eta_slip_min = ${s}, updated_at = now(),
        slip_flagged_at = CASE WHEN slip_flagged_at IS NULL AND ${s} >= ${SLIP_FLAG_MIN} THEN now() ELSE slip_flagged_at END
      WHERE id = ${Number(tripId)} AND (max_eta_slip_min IS NULL OR max_eta_slip_min < ${s})`);
  } catch (e) { tripFail(e); }
}

/**
 * Backfill origin_port_id + departed_at from an observed geofence EXIT at leg start. `exits` =
 * [{ mmsi, portId, ts(ms) }]. Guards: only unset departed_at, never the destination's own exit
 * (dest_port_id <> exit port), and only within a window around opened_at (a stray neighbor-zone exit
 * can't clobber a real departure).
 */
async function backfillTripOrigin(exits) {
  if (!enabled || !exits || !exits.length) return 0;
  const mmsi = exits.map((e) => String(e.mmsi));
  const port = exits.map((e) => e.portId);
  const ts = exits.map((e) => new Date(e.ts).toISOString());
  try {
    const rows = await withTimeout(sql`
      UPDATE trips t SET origin_port_id = COALESCE(t.origin_port_id, u.port_id), departed_at = u.ts, updated_at = now()
      FROM unnest(${mmsi}::text[], ${port}::text[], ${ts}::timestamptz[]) AS u(mmsi, port_id, ts)
      WHERE t.mmsi = u.mmsi AND t.status = 'open' AND t.departed_at IS NULL
        AND t.dest_port_id <> u.port_id
        AND u.ts BETWEEN t.opened_at - interval '30 min' AND t.opened_at + interval '6 hours'
      RETURNING t.id`);
    return Array.isArray(rows) ? rows.length : 0;
  } catch (e) { tripFail(e); return 0; }
}

/** Backfill dest_dwell_min on an arrived trip from the destination's geofence exit dwell. */
async function backfillDestDwell(exits) {
  if (!enabled || !exits || !exits.length) return 0;
  const mmsi = exits.map((e) => String(e.mmsi));
  const port = exits.map((e) => e.portId);
  const dwell = exits.map((e) => (Number.isFinite(e.dwellMin) ? e.dwellMin : null));
  try {
    const rows = await withTimeout(sql`
      UPDATE trips t SET dest_dwell_min = u.dwell, updated_at = now()
      FROM unnest(${mmsi}::text[], ${port}::text[], ${dwell}::real[]) AS u(mmsi, port_id, dwell)
      WHERE t.mmsi = u.mmsi AND t.dest_port_id = u.port_id AND t.status = 'arrived'
        AND t.dest_dwell_min IS NULL AND u.dwell IS NOT NULL
      RETURNING t.id`);
    return Array.isArray(rows) ? rows.length : 0;
  } catch (e) { tripFail(e); return 0; }
}

const TRIP_SEG_MAX_KN = 40;    // a leg between two points implying >40 kn is a bad AIS position → dropped
const TRIP_MOVING_MIN_KN = 1;  // speed above this counts as "under way" (excludes idle/berth samples)
const TRIP_SPEED_MIN_PTS = 3;  // need this many moving samples before an avg speed is trustworthy
// Wait this long after arrival before finalizing. Capture STOPS at arrival, so the point set is then
// fixed — but the last points captured while open may still sit in the relay's pendingTripPoints buffer
// (flushed every ~60s, requeued on a transient failure). Finalizing sooner would compute from a partial
// track and then the `distance_km IS NULL` gate would skip the trip forever, undercounting distance/speed.
// 5 min safely clears the 60s flush + a couple of requeues.
const TRIP_FINALIZE_GRACE_SEC = 300;

/**
 * Compute distance_km + avg_speed_kn for arrived trips from the TRIP_POINTS PATH (not great-circle
 * origin→dest, which needed an origin that's observed on only ~5% of trips). distance = summed haversine
 * between consecutive points (R=6371), dropping GPS-jump legs (> TRIP_SEG_MAX_KN). avg_speed = mean of
 * the vessel's own AIS speed while under way — cleaner than distance/time, which conflates cruising with
 * port idle. NULL until >=2 points (distance) / >=TRIP_SPEED_MIN_PTS moving points (speed). Idempotent
 * (only fills where distance_km IS NULL). Reproducible from the durable points.
 */
async function finalizeArrivedGeo() {
  if (!enabled) return 0;
  try {
    const rows = await withTimeout(sql`
      WITH tp AS (
        SELECT tp.trip_id, tp.speed_kn,
               2 * 6371 * asin(sqrt(
                 power(sin(radians(tp.lat - lag(tp.lat) OVER w) / 2), 2) +
                 cos(radians(lag(tp.lat) OVER w)) * cos(radians(tp.lat)) *
                 power(sin(radians(tp.lon - lag(tp.lon) OVER w) / 2), 2)
               )) AS seg_km,
               extract(epoch from (tp.ts - lag(tp.ts) OVER w)) / 3600.0 AS seg_h
        FROM trip_points tp
        JOIN trips t ON t.id = tp.trip_id
        WHERE t.status = 'arrived' AND t.distance_km IS NULL
          AND t.arrived_at < now() - make_interval(secs => ${TRIP_FINALIZE_GRACE_SEC})  -- let buffered points flush first
        WINDOW w AS (PARTITION BY tp.trip_id ORDER BY tp.ts)
      ),
      agg AS (
        SELECT trip_id,
               sum(seg_km) FILTER (WHERE seg_h > 0 AND (seg_km / seg_h) / 1.852 <= ${TRIP_SEG_MAX_KN}) AS km,
               avg(speed_kn) FILTER (WHERE speed_kn > ${TRIP_MOVING_MIN_KN}) AS moving_kn,
               count(*) FILTER (WHERE speed_kn > ${TRIP_MOVING_MIN_KN}) AS moving_pts
        FROM tp GROUP BY trip_id
      )
      UPDATE trips t SET
        distance_km = a.km,
        avg_speed_kn = CASE WHEN a.moving_pts >= ${TRIP_SPEED_MIN_PTS} THEN a.moving_kn END,
        updated_at = now()
      FROM agg a
      WHERE t.id = a.trip_id AND a.km IS NOT NULL
      RETURNING t.id`);
    return Array.isArray(rows) ? rows.length : 0;
  } catch (e) { tripFail(e); return 0; }
}

const TRIP_POINTS_RETENTION_DAYS = 90; // single source for the ABANDONED-trip retention window (prune + the get_trip 'track expired' note)

/**
 * Retention: drop trip_points of ABANDONED trips older than `days`. Arrived-trip points are kept
 * forever — they ARE the voyage-replay/route-history artifact (PHASE_C_SCOPE.md decision #2,
 * resolved 2026-07-03). Trip ROWS (aggregates) kept forever regardless.
 */
async function pruneTripPoints(days = TRIP_POINTS_RETENTION_DAYS) {
  if (!enabled) return 0;
  try {
    const rows = await withTimeout(sql`
      DELETE FROM trip_points tp USING trips t
      WHERE tp.trip_id = t.id AND t.status = 'abandoned' AND t.updated_at < now() - make_interval(days => ${days})
      RETURNING tp.trip_id`, 30_000);
    return Array.isArray(rows) ? rows.length : 0;
  } catch (e) { tripFail(e); return 0; }
}

/**
 * Serve /ais/port-history from Postgres, reshaped to the existing client contract
 * ({ snapshots:[{ts,ports:[...]}], events:[{ts,portId,mmsi,kind,dwellMin}], counts }).
 * No `sinceMs` → defaults to the full ~14-day retention window (matches limitSnap's cap), preserving
 * the old endpoint's "return the accumulated history" contract for baseline/backtest consumers.
 * `limitSnap` = max SNAPSHOTS (distinct ticks, all ports each) — NOT rows, so it can't slice a tick
 * in half; `limitEvt` = max event rows.
 */
async function queryPortHistory({ sinceMs, limitSnap = 4032, limitEvt = 20000, ports } = {}) {
  if (!enabled) return { snapshots: [], events: [], snapshotCount: 0, eventCount: 0, generatedAt: Date.now(), db: false };
  const since = new Date(Number.isFinite(sinceMs) ? sinceMs : Date.now() - 14 * 24 * 3600 * 1000).toISOString();
  // null → no port filter; an array → filter. Null-safe in one query (no nested-fragment composition,
  // which the neon serverless template doesn't support): `pf IS NULL OR port_id = ANY(pf)`.
  const pf = Array.isArray(ports) && ports.length ? ports : null;
  const [snapRows, evtRows] = await Promise.all([
    // Limit by distinct TICKS (a snapshot = all ports at one ts), then fetch every row for those
    // ticks — so `limitSnap` means snapshots, and a partial tick is never returned.
    sql`SELECT extract(epoch from ts)*1000 AS ts, port_id, at_port, at_port_raw, at_berth, at_anchor,
               inbound, eta_h6, eta_h12, eta_h24, eta_h48, feed_label, source, coverage_ok
        FROM port_snapshots
        WHERE ts IN (SELECT DISTINCT ts FROM port_snapshots WHERE ts >= ${since}::timestamptz ORDER BY ts DESC LIMIT ${limitSnap})
          AND (${pf}::text[] IS NULL OR port_id = ANY(${pf}::text[]))
        ORDER BY ts DESC`,
    sql`SELECT extract(epoch from ts)*1000 AS ts, port_id, mmsi, kind, dwell_min
        FROM port_events
        WHERE ts >= ${since}::timestamptz AND (${pf}::text[] IS NULL OR port_id = ANY(${pf}::text[]))
        ORDER BY ts DESC LIMIT ${limitEvt}`,
  ]);
  // Regroup flat snapshot rows back into { ts, ports: [...] } the FE expects.
  const byTs = new Map();
  for (const r of snapRows) {
    const t = Number(r.ts);
    if (!byTs.has(t)) byTs.set(t, { ts: t, ports: [] });
    byTs.get(t).ports.push({
      portId: r.port_id, atPort: r.at_port, atPortRaw: r.at_port_raw, atBerth: r.at_berth,
      atAnchor: r.at_anchor, inbound: r.inbound,
      inboundEta: { h6: r.eta_h6, h12: r.eta_h12, h24: r.eta_h24, h48: r.eta_h48 },
      congestion: r.feed_label, source: r.source, coverageOk: r.coverage_ok,
    });
  }
  const snapshots = [...byTs.values()].sort((a, b) => a.ts - b.ts);
  const events = evtRows.map((r) => ({ ts: Number(r.ts), portId: r.port_id, mmsi: r.mmsi, kind: r.kind, dwellMin: r.dwell_min })).reverse();
  return { snapshots, events, snapshotCount: snapshots.length, eventCount: events.length, generatedAt: Date.now(), db: true };
}

// ---------------------------------------------------------------------------
// Phase C serving — get_trip. A trip is a RECORD, not a sample, so it is fully showable the moment it
// exists; immature fields degrade with an honest note ('computing' / 'origin not observed' / 'sparse'
// / 'track expired') rather than min-N suppression. THE GATE (field flags) IS COMPUTED HERE so every
// consumer — relay handler, Vercel proxy, Marco tool, UI — reads one already-flagged payload.
// ---------------------------------------------------------------------------
const TRIP_TRACK_MIN_POINTS = 5;                 // below this the track is 'sparse', not shown as a path
const TRIP_OPEN_STALE_MS = 48 * 60 * 60_000;     // an open trip with no update this long is flagged stale
const TRIP_POINTS_RETENTION_MS = TRIP_POINTS_RETENTION_DAYS * 24 * 60 * 60_000; // reuse the prune window

/**
 * Serve one trip by id, or a vessel's latest trip by mmsi (prefers the open leg, else most recent).
 * Returns { found, trip:{…flagged fields}, track:[…]|null, pointCount, densityPerHr, notes:{field→note},
 * generatedAt, db }. `notes` keys every suppressed/flagged field so the UI shows a chip, never a bare 0.
 */
async function queryTrip({ id, mmsi } = {}) {
  if (!enabled) return { found: false, db: false, generatedAt: Date.now() };
  // Coerce id here (one place): accepts the tool's integer OR the relay's raw query-string.
  const idParam = id != null && id !== '' && Number.isFinite(Number(id)) ? Number(id) : null;
  const mmsiParam = mmsi != null ? String(mmsi) : null;
  if (idParam == null && mmsiParam == null) return { found: false, db: true, generatedAt: Date.now() };
  let rows;
  try {
    // One null-safe query for both lookups (neon serverless can't compose SQL fragments): by id, or —
    // when no id — the vessel's latest leg (open one first, else most recent). ORDER BY is a no-op for id.
    rows = await sql`
      SELECT t.id, t.mmsi, t.origin_port_id, t.dest_port_id, t.status,
             extract(epoch from t.opened_at) * 1000 AS opened_at,
             extract(epoch from t.departed_at) * 1000 AS departed_at,
             extract(epoch from t.arrived_at) * 1000 AS arrived_at,
             t.duration_min, t.dest_dwell_min, t.distance_km, t.avg_speed_kn,
             extract(epoch from t.departure_eta) * 1000 AS departure_eta, t.max_eta_slip_min, t.stalled,
             extract(epoch from t.updated_at) * 1000 AS updated_at,
             v.name AS vessel_name, v.imo, v.operator_name, v.category,
             po.name AS origin_name, pd.name AS dest_name
      FROM trips t
      LEFT JOIN vessels v ON v.mmsi = t.mmsi
      LEFT JOIN ports po ON po.port_id = t.origin_port_id
      LEFT JOIN ports pd ON pd.port_id = t.dest_port_id
      WHERE (${idParam}::bigint IS NOT NULL AND t.id = ${idParam}::bigint)
         OR (${idParam}::bigint IS NULL AND t.mmsi = ${mmsiParam})
      ORDER BY (t.status = 'open') DESC, t.opened_at DESC
      LIMIT 1`;
  } catch (e) { fail(e); return { found: false, db: true, error: 'query failed', generatedAt: Date.now() }; }
  const r = rows && rows[0];
  if (!r) return { found: false, db: true, generatedAt: Date.now() };

  const num = (x) => (x == null ? null : Number(x));
  const tripId = num(r.id);
  const status = r.status;
  const openedAt = num(r.opened_at);
  const departedAt = num(r.departed_at);
  const updatedAt = num(r.updated_at);
  const distanceKm = num(r.distance_km);
  const avgSpeedKn = num(r.avg_speed_kn);
  const destDwellMin = num(r.dest_dwell_min);
  const departureEta = num(r.departure_eta);
  const notes = {}; // field → suppression/annotation note, so a consumer looks up notes[field] directly

  // Track (bounded; PK(trip_id, ts) makes this an indexed range read).
  let track = null;
  let pointCount = 0;
  let densityPerHr = null;
  try {
    const pts = await sql`SELECT extract(epoch from ts) * 1000 AS ts, lat, lon, speed_kn, course,
        extract(epoch from eta) * 1000 AS eta, eta_slip_min
        FROM trip_points WHERE trip_id = ${tripId} ORDER BY ts ASC LIMIT 5000`;
    pointCount = pts.length;
    // Only abandoned tracks expire now (arrived-trip points are kept forever). Arrived trips pruned
    // under the pre-2026-07 policy fall through to the honest 'sparse; 0 waypoints' note instead.
    const trackExpired = pointCount === 0 && status === 'abandoned' && updatedAt != null && Date.now() - updatedAt > TRIP_POINTS_RETENTION_MS;
    if (pointCount >= TRIP_TRACK_MIN_POINTS) {
      track = pts.map((p) => ({ ts: num(p.ts), lat: num(p.lat), lon: num(p.lon), speedKn: num(p.speed_kn), course: num(p.course), eta: num(p.eta), etaSlipMin: num(p.eta_slip_min) }));
      const spanH = (track[track.length - 1].ts - track[0].ts) / 3_600_000;
      densityPerHr = spanH > 0 ? Math.round((pointCount / spanH) * 10) / 10 : null;
    } else if (trackExpired) {
      notes.track = 'track expired (90d retention)';
    } else {
      notes.track = `sparse; ${pointCount} waypoint${pointCount === 1 ? '' : 's'} captured`;
    }
  } catch (e) { fail(e); notes.track = 'track unavailable'; }

  // Field-level flags (the gate). distance = the sailed track path; speed = avg AIS speed under way —
  // both filled by the finalize sweep once the trip arrives with enough track (no origin needed).
  if (distanceKm == null) notes.distanceKm = status === 'open' ? 'computing (voyage in progress)' : (pointCount < 2 ? 'track too sparse for distance' : 'computing from track');
  if (avgSpeedKn == null) notes.avgSpeedKn = status === 'open' ? 'computing (voyage in progress)' : 'track too sparse for average speed';
  else notes.avgSpeedKn = 'average AIS speed while under way';
  if (destDwellMin == null && status === 'arrived') notes.destDwellMin = 'pending destination exit observation';
  if (departedAt == null && status !== 'open') notes.departedAt = 'departure not recorded';
  if (status === 'open' && updatedAt != null && Date.now() - updatedAt > TRIP_OPEN_STALE_MS) notes.status = 'stale (no recent position update)';

  return {
    found: true, db: true, generatedAt: Date.now(),
    trip: {
      id: tripId, mmsi: r.mmsi, vesselName: r.vessel_name || null, imo: r.imo || null,
      operator: r.operator_name || null, category: r.category || null, status,
      // Fall back to the port_id when the name join misses — a trip's dest can resolve to a
      // non-commercial port that isn't in the `ports` dim (those never geofence-close), so the id is
      // the only label we have. origin_port_id is null for mid-sea opens → origin stays null.
      originPortId: r.origin_port_id, origin: r.origin_name || r.origin_port_id || null,
      destPortId: r.dest_port_id, dest: r.dest_name || r.dest_port_id || null,
      openedAt, departedAt, arrivedAt: num(r.arrived_at), durationMin: num(r.duration_min),
      distanceKm, avgSpeedKn, destDwellMin, departureEta, maxEtaSlipMin: num(r.max_eta_slip_min),
      stalled: !!r.stalled,
      onTime: departureEta != null ? { slipMin: num(r.max_eta_slip_min), toleranceMin: 15 } : null,
    },
    track, pointCount, densityPerHr, notes,
  };
}

// --- Phase C PR-3: get_vessel_profile -----------------------------------------------------------
// Identity ALWAYS (Phase A dim is mature); stats gated per the PHASE_C_SCOPE.md metric catalog and
// computed HERE (single-gate) — a failed gate suppresses the field with {value:null, note}, never a
// silent 0. Window = 45 rolling days (disclosed as windowDays); lifetime counters all-time.
const PROFILE_WINDOW_DAYS = 45;
const VP_MIN_ARRIVED_45D = 5;   // trips_arrived_45d shown only at ≥5 (below that it reads as noise)
const VP_MIN_DWELL_OBS = 3;     // median_dwell_min needs ≥3 dwell observations
const VP_MIN_SPEED_OBS = 3;     // avg_speed_kn needs ≥3 finalized speeds
const VP_MIN_ROUTE_REPEAT = 3;  // top_routes: the top route must repeat ≥3×…
const VP_MIN_DISTINCT_ROUTES = 3; // …and the vessel must have ≥3 distinct routes in window
const VP_DORMANT_MS = 7 * 24 * 60 * 60_000; // no arrival in >7d → dormant flag
const VP_MIN_ONTIME_ELIGIBLE = 20; // on_time_fraction needs ≥20 eligible trips (PR-5 metric unlock)
// Fleet-wide +15 min tolerance (matches queryTrip's onTime.toleranceMin). Open decision #5 in
// PHASE_C_SCOPE.md — per-operator/configurable tolerance would replace this one constant.
const VP_ONTIME_TOLERANCE_MIN = 15;

/**
 * One vessel's profile by mmsi: identity (always) + gated 45d stats + lifetime counters.
 * Returns { found, vessel:{…identity, dormant}, stats:{…gated}, counts:{raw observation counts},
 * windowDays, notes:{field→note}, generatedAt, db } — same contract shape as queryTrip.
 */
async function queryVesselProfile({ mmsi } = {}) {
  if (!enabled) return { found: false, db: false, generatedAt: Date.now() };
  const mmsiParam = mmsi != null && String(mmsi).trim() !== '' ? String(mmsi).trim() : null;
  if (!mmsiParam) return { found: false, db: true, generatedAt: Date.now() };

  const num = (x) => (x == null ? null : Number(x));
  let v, agg, routeRows;
  try {
    // Identity + one aggregate pass + top routes, concurrently. The trips queries are per-mmsi
    // (ix_trips_mmsi; per-subject cardinality is tiny — PR-2 EXPLAIN: 0.2 ms worst-case subject).
    const [vrows, aggRows, rrows] = await Promise.all([
      sql`SELECT mmsi, imo, name, category, is_freight, operator_id, operator_name,
                 length_m, beam_m, draught_m,
                 extract(epoch from first_seen) * 1000 AS first_seen,
                 extract(epoch from last_seen)  * 1000 AS last_seen
          FROM vessels WHERE mmsi = ${mmsiParam}`,
      sql`SELECT count(*) FILTER (WHERE status = 'arrived') AS arrived_total,
                 extract(epoch from max(arrived_at) FILTER (WHERE status = 'arrived')) * 1000 AS last_arrival,
                 count(*) FILTER (WHERE status = 'arrived'
                   AND arrived_at >= now() - make_interval(days => ${PROFILE_WINDOW_DAYS})) AS arrived_45d,
                 count(dest_dwell_min) FILTER (WHERE status = 'arrived'
                   AND arrived_at >= now() - make_interval(days => ${PROFILE_WINDOW_DAYS})) AS dwell_obs,
                 percentile_cont(0.5) WITHIN GROUP (ORDER BY dest_dwell_min)
                   FILTER (WHERE status = 'arrived'
                     AND arrived_at >= now() - make_interval(days => ${PROFILE_WINDOW_DAYS})) AS median_dwell,
                 count(avg_speed_kn) FILTER (WHERE status = 'arrived'
                   AND arrived_at >= now() - make_interval(days => ${PROFILE_WINDOW_DAYS})) AS speed_obs,
                 avg(avg_speed_kn) FILTER (WHERE status = 'arrived'
                   AND arrived_at >= now() - make_interval(days => ${PROFILE_WINDOW_DAYS})) AS avg_speed,
                 count(DISTINCT origin_port_id || '>' || dest_port_id) FILTER (WHERE status = 'arrived'
                   AND origin_port_id IS NOT NULL
                   AND arrived_at >= now() - make_interval(days => ${PROFILE_WINDOW_DAYS})) AS distinct_routes,
                 -- eta_at_open (migration 006), NOT departure_eta IS NOT NULL: patchTripEta fills a
                 -- null ETA mid-voyage, and a late promise is trivially keepable — only the ETA
                 -- declared AT OPEN may score reliability.
                 count(*) FILTER (WHERE status = 'arrived' AND eta_at_open
                   AND arrived_at >= now() - make_interval(days => ${PROFILE_WINDOW_DAYS})) AS ontime_eligible,
                 count(*) FILTER (WHERE status = 'arrived' AND eta_at_open
                   AND arrived_at <= departure_eta + make_interval(mins => ${VP_ONTIME_TOLERANCE_MIN})
                   AND arrived_at >= now() - make_interval(days => ${PROFILE_WINDOW_DAYS})) AS ontime_hits
          FROM trips WHERE mmsi = ${mmsiParam}`,
      // Routes need an OBSERVED origin (~5%+ of opens are mid-sea → origin null → excluded, noted below).
      sql`SELECT t.origin_port_id, t.dest_port_id, count(*) AS n,
                 po.name AS origin_name, pd.name AS dest_name
          FROM trips t
          LEFT JOIN ports po ON po.port_id = t.origin_port_id
          LEFT JOIN ports pd ON pd.port_id = t.dest_port_id
          WHERE t.mmsi = ${mmsiParam} AND t.status = 'arrived' AND t.origin_port_id IS NOT NULL
            AND t.arrived_at >= now() - make_interval(days => ${PROFILE_WINDOW_DAYS})
          GROUP BY 1, 2, 4, 5 ORDER BY n DESC, 1, 2 LIMIT 5`,
    ]);
    v = vrows && vrows[0];
    agg = aggRows && aggRows[0];
    routeRows = rrows || [];
  } catch (e) { fail(e); return { found: false, db: true, error: 'query failed', generatedAt: Date.now() }; }
  if (!v) return { found: false, db: true, generatedAt: Date.now() };

  const notes = {};
  const arrivedTotal = num(agg?.arrived_total) || 0;
  const arrived45 = num(agg?.arrived_45d) || 0;
  const dwellObs = num(agg?.dwell_obs) || 0;
  const speedObs = num(agg?.speed_obs) || 0;
  const distinctRoutes = num(agg?.distinct_routes) || 0;
  const lastArrival = num(agg?.last_arrival);
  const ontimeEligible = num(agg?.ontime_eligible) || 0;
  const ontimeHits = num(agg?.ontime_hits) || 0;

  // The gate (spec: metric catalog). Suppressed = null + note; NEVER a silent 0.
  const stats = { tripsArrivedTotal: arrivedTotal, tripsArrived45d: null, medianDwellMin: null, avgSpeedKn: null, topRoutes: null, onTimeFraction: null };
  if (arrived45 >= VP_MIN_ARRIVED_45D) stats.tripsArrived45d = arrived45;
  else notes.tripsArrived45d = `insufficient arrived trips in window (${arrived45} of ${VP_MIN_ARRIVED_45D} needed)`;
  if (dwellObs >= VP_MIN_DWELL_OBS) stats.medianDwellMin = num(agg.median_dwell);
  else notes.medianDwellMin = `insufficient dwell observations (${dwellObs} of ${VP_MIN_DWELL_OBS} needed)`;
  if (speedObs >= VP_MIN_SPEED_OBS) {
    stats.avgSpeedKn = num(agg.avg_speed);
    notes.avgSpeedKn = 'average AIS speed while under way (arrived trips in window)';
  } else notes.avgSpeedKn = `insufficient speed observations (${speedObs} of ${VP_MIN_SPEED_OBS} needed)`;
  const topRepeat = routeRows.length ? num(routeRows[0].n) : 0;
  if (distinctRoutes >= VP_MIN_DISTINCT_ROUTES && topRepeat >= VP_MIN_ROUTE_REPEAT) {
    stats.topRoutes = routeRows.map((r) => ({
      originPortId: r.origin_port_id, origin: r.origin_name || r.origin_port_id,
      destPortId: r.dest_port_id, dest: r.dest_name || r.dest_port_id, trips: num(r.n),
    }));
    notes.topRoutes = 'observed-origin voyages only (mid-sea opens excluded)';
  } else {
    notes.topRoutes = `insufficient route history (${distinctRoutes} distinct route${distinctRoutes === 1 ? '' : 's'}, top repeat ${topRepeat}; need ≥${VP_MIN_DISTINCT_ROUTES} distinct and top ≥${VP_MIN_ROUTE_REPEAT})`;
  }
  // On-time = arrived within +tolerance of the ETA the leg DECLARED AT OPEN (departure_eta) — the
  // promise made, not the last revised guess. Eligible = arrived trips where that promise exists.
  if (ontimeEligible >= VP_MIN_ONTIME_ELIGIBLE) {
    stats.onTimeFraction = Math.round((ontimeHits / ontimeEligible) * 100) / 100;
    notes.onTimeFraction = `arrived within +${VP_ONTIME_TOLERANCE_MIN} min of the ETA declared at voyage open (${ontimeHits}/${ontimeEligible} eligible trips)`;
  } else {
    notes.onTimeFraction = `insufficient eligible trips (${ontimeEligible} of ${VP_MIN_ONTIME_ELIGIBLE} needed — needs an ETA observed at voyage open)`;
  }

  // Dormant: had arrivals, but none in >7d. No arrivals at all is its own (weaker) note.
  let dormant = false;
  if (lastArrival != null && Date.now() - lastArrival > VP_DORMANT_MS) {
    dormant = true;
    notes.dormant = 'no arrival in >7 days';
  } else if (lastArrival == null) {
    notes.lastArrival = 'no arrivals recorded yet';
  }

  return {
    found: true, db: true, generatedAt: Date.now(),
    vessel: {
      mmsi: v.mmsi, imo: v.imo || null, name: v.name || null, category: v.category || null,
      isFreight: !!v.is_freight, operatorId: v.operator_id || null, operator: v.operator_name || null,
      lengthM: num(v.length_m), beamM: num(v.beam_m), draughtM: num(v.draught_m),
      firstSeen: num(v.first_seen), lastSeen: num(v.last_seen), lastArrival, dormant,
    },
    stats,
    counts: { arrived45d: arrived45, dwellObs, speedObs, distinctRoutes, topRepeat, ontimeEligible },
    windowDays: PROFILE_WINDOW_DAYS,
    notes,
  };
}

// --- Phase C PR-4: get_port_profile -------------------------------------------------------------
// Identity + coverage block ALWAYS; aggregates gated per the metric catalog; live congestion REUSES
// relativeCongestion (already gated n≥BASELINE_MIN_DAYS → null/'unknown', never 'clear'), fed from
// the LATEST stored snapshot (5-min cadence) + the matching local dow×hour baseline bucket — fully
// DB-side, so this stays a single-gate query fn with no relay in-memory state.
const PP_MIN_UNIQUE_VESSELS = 5;
const PP_MIN_ARRIVALS_7D = 5;
const PP_MIN_DWELL_OBS = 3;
const PP_MIN_OPERATOR_ARRIVALS = 20; // operator_mix needs ≥20 arrivals in window
const PP_SNAPSHOT_FRESH_MS = 15 * 60_000; // live congestion only off a fresh (<15 min) snapshot
const PP_COVERAGE_WINDOW_DAYS = 7;   // coverage block = last 7d of snapshots
const PP_MIN_PEAK_ARRIVALS = 100;    // peak_hours needs ≥100 arrivals in window (PR-5 metric unlock)
const PP_MIN_RATE_ARRIVALS = 20;     // arrivals_per_day needs ≥20 arrivals…
const PP_MIN_RATE_DAYS = 3;          // …spread over ≥3 distinct local days (else the rate is noise)

/**
 * One port's profile by port_id: identity (always) + live relative congestion (gated) + gated 45d
 * arrival stats + a coverage block (always — source mix, coverage_frac, last_degraded_at).
 * Same contract shape as queryTrip/queryVesselProfile: { found, port, congestion, stats, counts,
 * coverage, windowDays, notes, generatedAt, db }.
 */
async function queryPortProfile({ port } = {}) {
  if (!enabled) return { found: false, db: false, generatedAt: Date.now() };
  const portParam = port != null && String(port).trim() !== '' ? String(port).trim().toLowerCase() : null;
  if (!portParam) return { found: false, db: true, generatedAt: Date.now() };

  const num = (x) => (x == null ? null : Number(x));
  let p, agg, peakRows, opRows, cov, srcRows, live;
  try {
    const [prows, aggRows, pkrows, orows, covRows, srows, lrows] = await Promise.all([
      sql`SELECT port_id, name, country, region, tz, commercial FROM ports WHERE port_id = ${portParam}`,
      sql`SELECT count(*) AS arrived_45d,
                 count(DISTINCT mmsi) AS unique_vessels,
                 count(*) FILTER (WHERE arrived_at >= now() - interval '7 days') AS arrivals_7d,
                 count(dest_dwell_min) AS dwell_obs,
                 percentile_cont(0.5) WITHIN GROUP (ORDER BY dest_dwell_min) AS median_dwell,
                 count(DISTINCT (t.arrived_at AT TIME ZONE p.tz)::date) AS arrival_days,
                 extract(epoch from (now() - min(t.arrived_at))) AS span_sec
          FROM trips t JOIN ports p ON p.port_id = t.dest_port_id
          WHERE dest_port_id = ${portParam} AND status = 'arrived'
            AND arrived_at >= now() - make_interval(days => ${PROFILE_WINDOW_DAYS})`,
      // Peak arrival hours in the port's LOCAL time (congestion follows local working hours).
      sql`SELECT EXTRACT(hour FROM t.arrived_at AT TIME ZONE p.tz)::int AS hr, count(*) AS n
          FROM trips t JOIN ports p ON p.port_id = t.dest_port_id
          WHERE t.dest_port_id = ${portParam} AND t.status = 'arrived'
            AND t.arrived_at >= now() - make_interval(days => ${PROFILE_WINDOW_DAYS})
          GROUP BY 1 ORDER BY n DESC, hr LIMIT 3`,
      sql`SELECT coalesce(v.operator_name, v.operator_id, 'unknown') AS operator, count(*) AS n
          FROM trips t LEFT JOIN vessels v ON v.mmsi = t.mmsi
          WHERE t.dest_port_id = ${portParam} AND t.status = 'arrived'
            AND t.arrived_at >= now() - make_interval(days => ${PROFILE_WINDOW_DAYS})
          GROUP BY 1 ORDER BY n DESC, 1 LIMIT 8`,
      sql`SELECT count(*) AS n, count(*) FILTER (WHERE coverage_ok) AS n_ok,
                 extract(epoch from max(ts) FILTER (WHERE NOT coverage_ok)) * 1000 AS last_degraded_at
          FROM port_snapshots
          WHERE port_id = ${portParam} AND ts > now() - make_interval(days => ${PP_COVERAGE_WINDOW_DAYS})`,
      sql`SELECT source, count(*) AS n
          FROM port_snapshots
          WHERE port_id = ${portParam} AND ts > now() - make_interval(days => ${PP_COVERAGE_WINDOW_DAYS})
          GROUP BY 1 ORDER BY n DESC`,
      // Latest snapshot + the baseline bucket for the port's CURRENT local dow×hour (tz from the dim,
      // so the bucket matches how refreshBaselines built them).
      sql`SELECT s.at_berth, s.coverage_ok, extract(epoch from s.ts) * 1000 AS ts,
                 EXTRACT(dow  FROM now() AT TIME ZONE p.tz)::smallint AS dow,
                 EXTRACT(hour FROM now() AT TIME ZONE p.tz)::smallint AS hour,
                 b.p75, b.p90, b.n AS days
          FROM port_snapshots s
          JOIN ports p ON p.port_id = s.port_id
          LEFT JOIN port_baselines b ON b.port_id = s.port_id
            AND b.dow  = EXTRACT(dow  FROM now() AT TIME ZONE p.tz)::smallint
            AND b.hour = EXTRACT(hour FROM now() AT TIME ZONE p.tz)::smallint
          WHERE s.port_id = ${portParam}
          ORDER BY s.ts DESC LIMIT 1`,
    ]);
    p = prows && prows[0];
    agg = aggRows && aggRows[0];
    peakRows = pkrows || [];
    opRows = orows || [];
    cov = covRows && covRows[0];
    srcRows = srows || [];
    live = lrows && lrows[0];
  } catch (e) { fail(e); return { found: false, db: true, error: 'query failed', generatedAt: Date.now() }; }
  if (!p) return { found: false, db: true, generatedAt: Date.now() };

  const notes = {};
  const arrived45 = num(agg?.arrived_45d) || 0;
  const uniqueVessels = num(agg?.unique_vessels) || 0;
  const arrivals7d = num(agg?.arrivals_7d) || 0;
  const dwellObs = num(agg?.dwell_obs) || 0;

  // Live relative congestion — REUSE the one gate (n≥BASELINE_MIN_DAYS inside relativeCongestion),
  // fed a single-bucket map keyed exactly like loadBaselines builds it. Stale snapshot → suppressed.
  let congestionRel = null;
  let congestionAsOf = null;
  const snapTs = num(live?.ts);
  if (!live) {
    notes.congestionRel = 'no snapshots recorded for this port';
  } else if (snapTs == null || Date.now() - snapTs > PP_SNAPSHOT_FRESH_MS) {
    notes.congestionRel = 'stale snapshot (no fresh position data)';
  } else if (!live.coverage_ok) {
    // A dark feed still writes fresh rows (coverage_ok=false, empty counts) — comparing that
    // zero against a warm baseline would read as 'clear'. No coverage → unknown, never 'clear'.
    notes.congestionRel = 'no live coverage for this port right now (feed dark)';
  } else {
    const dow = num(live.dow);
    const hour = num(live.hour);
    const bucket = live.days != null
      ? new Map([[`${portParam}:${dow}:${hour}`, { p75: num(live.p75), p90: num(live.p90), days: num(live.days) }]])
      : new Map();
    congestionRel = relativeCongestion(bucket, portParam, num(live.at_berth), dow, hour);
    congestionAsOf = snapTs;
    if (congestionRel == null) notes.congestionRel = `unknown (baseline for this local hour needs ≥${BASELINE_MIN_DAYS} observed days)`;
  }

  // The gate (spec: metric catalog). Suppressed = null + note; NEVER a silent 0.
  const stats = { uniqueVessels: null, recentArrivals7d: null, medianDwellMin: null, operatorMix: null, peakHours: null, arrivalsPerDay: null };
  if (uniqueVessels >= PP_MIN_UNIQUE_VESSELS) stats.uniqueVessels = uniqueVessels;
  else notes.uniqueVessels = `insufficient distinct vessels in window (${uniqueVessels} of ${PP_MIN_UNIQUE_VESSELS} needed)`;
  if (arrivals7d >= PP_MIN_ARRIVALS_7D) stats.recentArrivals7d = arrivals7d;
  else notes.recentArrivals7d = `insufficient arrivals in the last 7 days (${arrivals7d} of ${PP_MIN_ARRIVALS_7D} needed)`;
  if (dwellObs >= PP_MIN_DWELL_OBS) stats.medianDwellMin = num(agg.median_dwell);
  else notes.medianDwellMin = `insufficient dwell observations (${dwellObs} of ${PP_MIN_DWELL_OBS} needed)`;
  if (arrived45 >= PP_MIN_OPERATOR_ARRIVALS) {
    stats.operatorMix = opRows.map((r) => ({ operator: r.operator, trips: num(r.n), share: Math.round((num(r.n) / arrived45) * 100) / 100 }));
  } else notes.operatorMix = `insufficient arrivals for an operator mix (${arrived45} of ${PP_MIN_OPERATOR_ARRIVALS} needed)`;
  if (arrived45 >= PP_MIN_PEAK_ARRIVALS && peakRows.length) {
    stats.peakHours = peakRows.map((r) => ({ hour: num(r.hr), arrivals: num(r.n) }));
    notes.peakHours = `busiest arrival hours in ${p.tz} local time`;
  } else {
    notes.peakHours = `insufficient arrivals for peak hours (${arrived45} of ${PP_MIN_PEAK_ARRIVALS} needed)`;
  }
  // Rate over the OBSERVED span, not the full window — tracking younger than 45d must not read as
  // a low rate. Span = earliest in-window arrival → now, floored at 1 day; gated on volume + spread.
  const arrivalDays = num(agg?.arrival_days) || 0;
  const spanDays = Math.max(1, (num(agg?.span_sec) || 0) / 86_400);
  if (arrived45 >= PP_MIN_RATE_ARRIVALS && arrivalDays >= PP_MIN_RATE_DAYS) {
    stats.arrivalsPerDay = Math.round((arrived45 / spanDays) * 10) / 10;
    notes.arrivalsPerDay = `over the ${Math.round(spanDays * 10) / 10} observed days in window`;
  } else {
    notes.arrivalsPerDay = `insufficient history for a daily rate (${arrived45} arrivals over ${arrivalDays} day${arrivalDays === 1 ? '' : 's'}; need ≥${PP_MIN_RATE_ARRIVALS} over ≥${PP_MIN_RATE_DAYS} days)`;
  }

  // Coverage block — ALWAYS (the honesty layer: how complete was observation over the window).
  const covN = num(cov?.n) || 0;
  const coverage = {
    windowDays: PP_COVERAGE_WINDOW_DAYS,
    snapshots: covN,
    coverageFrac: covN > 0 ? Math.round((num(cov.n_ok) / covN) * 1000) / 1000 : null,
    lastDegradedAt: num(cov?.last_degraded_at),
    sources: Object.fromEntries(srcRows.map((r) => [r.source, num(r.n)])),
  };
  if (covN === 0) notes.coverage = 'no snapshots in the coverage window';

  return {
    found: true, db: true, generatedAt: Date.now(),
    port: {
      portId: p.port_id, name: p.name, country: p.country, region: p.region || null,
      tz: p.tz, commercial: !!p.commercial,
    },
    congestion: { relative: congestionRel, asOf: congestionAsOf },
    stats,
    counts: { arrived45d: arrived45, uniqueVessels, arrivals7d, dwellObs, arrivalDays },
    coverage,
    windowDays: PROFILE_WINDOW_DAYS,
    notes,
  };
}

// --- P0.3: relative congestion baseline ---------------------------------------------------------
// Congestion "for THIS port, right now" vs its own normal for the matching LOCAL day-of-week × hour
// (congestion follows local working hours). Replaces the meaningless absolute atPort≥8 threshold
// (every mega-port always "congested"). Built on at_berth (the clean occupancy signal), and only
// from coverage_ok rows (P0.2) so dark/degraded windows never poison the baseline.
const BASELINE_MIN_DAYS = 3; // a dow×hour bucket must be seen on ≥3 distinct local days before trusted

/** Recompute all per-port × local-dow × local-hour at_berth percentiles. Returns bucket count. */
async function refreshBaselines() {
  if (!enabled) return 0;
  try {
    const res = await withTimeout(sql`
      INSERT INTO port_baselines (port_id, dow, hour, p50, p75, p90, mean, stddev, n, updated_at)
      SELECT s.port_id,
             EXTRACT(dow  FROM s.ts AT TIME ZONE p.tz)::smallint,
             EXTRACT(hour FROM s.ts AT TIME ZONE p.tz)::smallint,
             percentile_cont(0.5)  WITHIN GROUP (ORDER BY s.at_berth),
             percentile_cont(0.75) WITHIN GROUP (ORDER BY s.at_berth),
             percentile_cont(0.90) WITHIN GROUP (ORDER BY s.at_berth),
             avg(s.at_berth), stddev_pop(s.at_berth),
             -- n = DISTINCT local days observed (NOT sample count): cadence-independent, so six
             -- adjacent 5-min samples from one hour can't trip the trust gate. Percentiles are
             -- still computed over every sample in the group.
             count(DISTINCT (s.ts AT TIME ZONE p.tz)::date), now()
      FROM port_snapshots s JOIN ports p USING (port_id)
      WHERE s.coverage_ok AND s.at_berth IS NOT NULL AND s.ts > now() - interval '8 weeks'
      GROUP BY 1, 2, 3
      ON CONFLICT (port_id, dow, hour) DO UPDATE SET
        p50=EXCLUDED.p50, p75=EXCLUDED.p75, p90=EXCLUDED.p90,
        mean=EXCLUDED.mean, stddev=EXCLUDED.stddev, n=EXCLUDED.n, updated_at=EXCLUDED.updated_at
      RETURNING 1`, 30_000);
    // Expire buckets that aged out of the 8-week window (not upserted this run → stale updated_at),
    // so /ais/ports never serves congestionRel from months-old percentiles. 2 days survives a
    // missed nightly run without false-deleting a still-current bucket.
    await withTimeout(sql`DELETE FROM port_baselines WHERE updated_at < now() - interval '2 days'`);
    const n = Array.isArray(res) ? res.length : 0;
    stats.baselineBuckets = n;
    stats.baselineRefreshedAt = Date.now();
    return n;
  } catch (e) { fail(e); return 0; }
}

/** Load baselines into memory: Map(`${portId}:${dow}:${hour}` → {p75,p90,days}). Boot + post-refresh. */
async function loadBaselines() {
  if (!enabled) return new Map();
  const rows = await sql`SELECT port_id, dow, hour, p75, p90, n FROM port_baselines`;
  const m = new Map();
  for (const r of rows) m.set(`${r.port_id}:${r.dow}:${r.hour}`, { p75: Number(r.p75), p90: Number(r.p90), days: Number(r.n) });
  return m;
}

/**
 * Relative congestion for a port RIGHT NOW: current at_berth vs its baseline for the matching
 * local dow×hour. Returns null ("unknown") until the bucket has been seen on ≥minDays distinct
 * local days — so it self-activates only after real history (~weeks), not after 30min of one hour.
 * Pure: caller passes the in-memory baselines (see loadBaselines) + the port's LOCAL dow/hour.
 */
function relativeCongestion(baselines, portId, atBerth, dow, hour, minDays = BASELINE_MIN_DAYS) {
  const b = baselines?.get(`${portId}:${dow}:${hour}`);
  if (!b || b.days < minDays || !Number.isFinite(atBerth)) return null; // unknown until enough days
  if (atBerth > b.p90) return 'congested';
  if (atBerth > b.p75) return 'busy';
  return 'clear';
}

module.exports = {
  enabled, syncPorts, syncVessels, writeSnapshot, writeEvents, queryPortHistory,
  refreshBaselines, loadBaselines, relativeCongestion, BASELINE_MIN_DAYS,
  // Trips lifecycle (Phase B)
  openTrip, finishTrip, appendTripPoints, loadOpenTrips, abandonTrips, abandonStaleTrips,
  markStalled, patchTripEta, bumpTripEtaSlip, backfillTripOrigin, backfillDestDwell,
  finalizeArrivedGeo, pruneTripPoints,
  // Phase C serving
  queryTrip, queryVesselProfile, queryPortProfile,
  stats, COUNTRY_TZ, tzForCountry,
};
