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
const stats = { enabled, portsSynced: 0, snapshotRows: 0, eventRows: 0, lastWriteAt: null, lastWriteOk: null, lastError: null, baselineBuckets: 0, baselineRefreshedAt: null };
function ok(kind, n) { stats.lastWriteAt = Date.now(); stats.lastWriteOk = true; if (kind) stats[kind] += n; }
function fail(e) { stats.lastWriteAt = Date.now(); stats.lastWriteOk = false; stats.lastError = String(e && e.message || e).slice(0, 200); }

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
  enabled, syncPorts, writeSnapshot, writeEvents, queryPortHistory,
  refreshBaselines, loadBaselines, relativeCongestion, BASELINE_MIN_DAYS,
  stats, COUNTRY_TZ, tzForCountry,
};
