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

// In-memory counters read synchronously by /health (never do an async PG call in the health path).
const stats = { enabled, portsSynced: 0, snapshotRows: 0, eventRows: 0, lastWriteAt: null, lastWriteOk: null, lastError: null };
function ok(kind, n) { stats.lastWriteAt = Date.now(); stats.lastWriteOk = true; if (kind) stats[kind] += n; }
function fail(e) { stats.lastWriteAt = Date.now(); stats.lastWriteOk = false; stats.lastError = String(e && e.message || e).slice(0, 200); }

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
        ${ports.map((p) => COUNTRY_TZ[p.country || 'IT'] || 'Europe/Rome')}::text[]
      )
      ON CONFLICT (port_id) DO UPDATE SET
        name=EXCLUDED.name, country=EXCLUDED.country, region=EXCLUDED.region,
        lat=EXCLUDED.lat, lon=EXCLUDED.lon, tz=EXCLUDED.tz`;
    stats.portsSynced = ports.length;
  } catch (e) { fail(e); throw e; }
}

/** Batch-insert one congestion snapshot (all ports for a tick). `rows` = the per-port entries. */
async function writeSnapshot(tsMs, rows, meta = {}) {
  if (!enabled || !rows || !rows.length) return;
  const ts = new Date(tsMs).toISOString();
  const eta = (h) => rows.map((r) => (r.inboundEta && Number.isFinite(r.inboundEta[h]) ? r.inboundEta[h] : null));
  const col = (f) => rows.map((r) => (Number.isFinite(r[f]) ? r[f] : null));
  try {
    await sql`
      INSERT INTO port_snapshots
        (ts, port_id, at_port, at_port_raw, at_berth, at_anchor, inbound, eta_h6, eta_h12, eta_h24, eta_h48, feed_label, source, coverage_ok)
      SELECT ${ts}::timestamptz, u.port_id, u.at_port, u.at_port_raw, u.at_berth, u.at_anchor, u.inbound,
             u.eta_h6, u.eta_h12, u.eta_h24, u.eta_h48, u.feed_label, ${meta.source || 'relay'}, ${meta.coverageOk !== false}
      FROM unnest(
        ${rows.map((r) => r.portId)}::text[], ${col('atPort')}::int[], ${col('atPortRaw')}::int[],
        ${col('atBerth')}::int[], ${col('atAnchor')}::int[], ${col('inbound')}::int[],
        ${eta('h6')}::int[], ${eta('h12')}::int[], ${eta('h24')}::int[], ${eta('h48')}::int[],
        ${rows.map((r) => r.congestion || null)}::text[]
      ) AS u(port_id, at_port, at_port_raw, at_berth, at_anchor, inbound, eta_h6, eta_h12, eta_h24, eta_h48, feed_label)
      ON CONFLICT (port_id, ts) DO UPDATE SET
        at_port=EXCLUDED.at_port, at_port_raw=EXCLUDED.at_port_raw, at_berth=EXCLUDED.at_berth,
        at_anchor=EXCLUDED.at_anchor, inbound=EXCLUDED.inbound, eta_h6=EXCLUDED.eta_h6,
        eta_h12=EXCLUDED.eta_h12, eta_h24=EXCLUDED.eta_h24, eta_h48=EXCLUDED.eta_h48,
        feed_label=EXCLUDED.feed_label, source=EXCLUDED.source, coverage_ok=EXCLUDED.coverage_ok`;
    ok('snapshotRows', rows.length);
  } catch (e) { fail(e); }
}

/** Batch-insert geofence enter/exit events (dwell_min on exit, nullable). */
async function writeEvents(events, meta = {}) {
  if (!enabled || !events || !events.length) return;
  try {
    await sql`
      INSERT INTO port_events (ts, port_id, mmsi, kind, dwell_min, source)
      SELECT to_timestamp(u.ts / 1000.0), u.port_id, u.mmsi, u.kind, u.dwell_min, ${meta.source || 'relay'}
      FROM unnest(
        ${events.map((e) => e.ts)}::bigint[], ${events.map((e) => e.portId)}::text[],
        ${events.map((e) => String(e.mmsi))}::text[], ${events.map((e) => e.kind)}::text[],
        ${events.map((e) => (Number.isFinite(e.dwellMin) ? e.dwellMin : null))}::real[]
      ) AS u(ts, port_id, mmsi, kind, dwell_min)`;
    ok('eventRows', events.length);
  } catch (e) { fail(e); }
}

/**
 * Serve /ais/port-history from Postgres, reshaped to the existing client contract
 * ({ snapshots:[{ts,ports:[...]}], events:[{ts,portId,mmsi,kind,dwellMin}], counts }).
 * `sinceMs` defaults to 24h ago; `limitSnap`/`limitEvt` cap the returned slices.
 */
async function queryPortHistory({ sinceMs, limitSnap = 4032, limitEvt = 20000, ports } = {}) {
  if (!enabled) return { snapshots: [], events: [], snapshotCount: 0, eventCount: 0, generatedAt: Date.now(), db: false };
  const since = new Date(Number.isFinite(sinceMs) ? sinceMs : Date.now() - 24 * 3600 * 1000).toISOString();
  // null → no port filter; an array → filter. Null-safe in one query (no nested-fragment composition,
  // which the neon serverless template doesn't support): `pf IS NULL OR port_id = ANY(pf)`.
  const pf = Array.isArray(ports) && ports.length ? ports : null;
  const [snapRows, evtRows] = await Promise.all([
    sql`SELECT extract(epoch from ts)*1000 AS ts, port_id, at_port, at_port_raw, at_berth, at_anchor,
               inbound, eta_h6, eta_h12, eta_h24, eta_h48, feed_label, source, coverage_ok
        FROM port_snapshots
        WHERE ts >= ${since}::timestamptz AND (${pf}::text[] IS NULL OR port_id = ANY(${pf}::text[]))
        ORDER BY ts DESC LIMIT ${limitSnap}`,
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

module.exports = { enabled, syncPorts, writeSnapshot, writeEvents, queryPortHistory, stats, COUNTRY_TZ };
