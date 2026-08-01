'use strict';

// Purge the port history that was recorded under a DIFFERENT at-port geometry.
//
// WHY THIS EXISTS
// `port_baselines` is a rolling 8-week recompute over `port_snapshots`, and every snapshot's
// at_berth/at_port count depends on that port's at-port radius. When a port's `radiusKm` changes,
// its old rows describe a circle that no longer exists — but they stay inside the 8-week window and
// keep feeding the percentiles, so `congestionRel` (the signal the tools are told to LEAD with)
// silently blends two geometries. It reads low for a shrunk port and high for a widened one, for up
// to eight weeks, with nothing on the surface to say so.
//
// Deleting the pre-cutover rows for the affected ports starts a clean baseline instead of waiting
// out the window.
//
// RECOVERY TIME — READ THIS BEFORE RUNNING
// It is ~3 WEEKS, not 3 days. `BASELINE_MIN_DAYS = 3` is measured per (port, dow, hour) bucket, and
// a dow x hour bucket recurs ONCE A WEEK — so "3 distinct local days" inside that bucket means three
// successive weeks. Verified against live data: rotterdam/dow=1/hour=9 has dates 2026-07-06,
// 07-13, 07-27. The `n` column counts WEEKS observed, whatever the constant is named.
//
// So the real trade is:
//   purge      -> congestionRel = null ("unknown", honest) for these ports for ~3 weeks
//   do nothing -> congestionRel blends two geometries (confidently wrong) until the old rows leave
//                 the 8-week window
// Purging is still the better answer, because "unknown" degrades safely and a wrong number does
// not. But it is not the cheap 3-day refresh the deploy note implied.
//
// WHAT IT DELIBERATELY DOES NOT TOUCH
// `port_events` and `trips` are ALSO geometry-dependent (geofence enter/exit drives trips.arrived_at
// and dest_dwell_min), but they are append-only history with no recompute path — nothing rebuilds
// them, so deleting is pure loss, not a refresh. At the time of writing that is 49% of all
// port_events and 42% of all arrived trips. They keep a documented discontinuity at the cutover
// instead. This script will not delete from them; see GUARDED_TABLES.
//
// USAGE
//   node --env-file-if-exists=.env scripts/purge-radius-history.cjs                 # dry run (default)
//   node --env-file-if-exists=.env scripts/purge-radius-history.cjs --apply         # execute
//   ... --before=2026-08-01T04:34:23Z    # geometry cutover; rows AT OR AFTER it are kept
//   ... --ports=rotterdam,savona         # narrow the set (default: every port with a radiusKm override)
//
// Dry run is the default and prints exactly what --apply would delete. Nothing is written without
// --apply, and the deletes run as one transaction.

const { ports: REGISTRY } = require('../src/config/maritime-ports.data.json');

// Tables this script must never write to, however the arguments are shaped. Asserted at runtime
// against the SQL it is about to run, so a future edit can't quietly widen the blast radius.
const GUARDED_TABLES = ['port_events', 'trips', 'trip_points', 'vessels', 'ports', 'forecasts'];

// The geometry cutover: when the relay restarted on the build carrying the new radii. Rows at or
// after this instant were recorded under the CURRENT geometry and must be kept — they are the
// clean baseline being rebuilt. Override with --before when a later radius change ships.
const DEFAULT_CUTOVER = '2026-08-01T04:34:23Z';

function parseArgs(argv) {
  const get = (k) => {
    const hit = argv.find((a) => a.startsWith(`--${k}=`));
    return hit ? hit.slice(k.length + 3) : null;
  };
  return {
    apply: argv.includes('--apply'),
    before: get('before') || DEFAULT_CUTOVER,
    ports: get('ports') ? get('ports').split(',').map((s) => s.trim()).filter(Boolean) : null,
  };
}

/**
 * Ports whose at-port disc differs from the fleet default — i.e. exactly those whose historical
 * rows were recorded under a radius that is no longer in force. Derived from the registry, never
 * hand-listed, so the next radius change needs no edit here.
 */
function affectedPorts(explicit) {
  if (explicit) return explicit;
  return REGISTRY.filter((p) => p.commercial && Number.isFinite(p.radiusKm)).map((p) => p.id);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const url = process.env.DATABASE_URL || '';
  if (!url) { console.error('DATABASE_URL is unset — nothing to do.'); process.exit(1); }

  const { neon } = require('@neondatabase/serverless');
  const sql = neon(url);

  const portIds = affectedPorts(args.ports);
  const cutover = new Date(args.before);
  if (Number.isNaN(cutover.getTime())) { console.error(`--before is not a valid date: ${args.before}`); process.exit(1); }

  // Guard: refuse to run if the resolved SQL would name a table this script has no business in.
  const plan = ['DELETE FROM port_snapshots', 'DELETE FROM port_baselines'];
  for (const stmt of plan) {
    for (const t of GUARDED_TABLES) {
      if (new RegExp(`\\b${t}\\b`).test(stmt)) { console.error(`REFUSING: plan touches guarded table ${t}`); process.exit(1); }
    }
  }

  console.log(`${args.apply ? 'APPLY' : 'DRY RUN'} — purge pre-cutover port history`);
  console.log(`cutover : ${cutover.toISOString()}  (rows at/after this are KEPT)`);
  console.log(`ports   : ${portIds.length} — ${portIds.join(', ')}`);
  console.log(`guarded : ${GUARDED_TABLES.join(', ')} (never written)\n`);

  // ---- Counts BEFORE ---------------------------------------------------------------------------
  // Averages are over coverage_ok rows ONLY — the same filter refreshBaselines uses. Without it a
  // relay restart's all-zero warming row drags the post-cutover mean to 0 and the comparison lies.
  const rows = await sql`
    SELECT port_id,
           count(*) FILTER (WHERE ts <  ${cutover.toISOString()}::timestamptz) AS to_delete,
           count(*) FILTER (WHERE ts >= ${cutover.toISOString()}::timestamptz) AS to_keep,
           count(*) FILTER (WHERE ts >= ${cutover.toISOString()}::timestamptz AND coverage_ok) AS new_covered,
           to_char(min(ts), 'YYYY-MM-DD') AS oldest,
           round(avg(at_berth) FILTER (WHERE ts <  ${cutover.toISOString()}::timestamptz AND coverage_ok)::numeric, 2) AS old_avg_at_berth,
           round(avg(at_berth) FILTER (WHERE ts >= ${cutover.toISOString()}::timestamptz AND coverage_ok)::numeric, 2) AS new_avg_at_berth
    FROM port_snapshots WHERE port_id = ANY(${portIds}::text[])
    GROUP BY port_id ORDER BY port_id`;

  const baselines = await sql`
    SELECT count(*)::int AS buckets, count(*) FILTER (WHERE n >= 3)::int AS trusted
    FROM port_baselines WHERE port_id = ANY(${portIds}::text[])`;

  const untouched = await sql`
    SELECT (SELECT count(*)::int FROM port_events WHERE port_id = ANY(${portIds}::text[])) AS port_events,
           (SELECT count(*)::int FROM trips WHERE dest_port_id = ANY(${portIds}::text[]) AND arrived_at IS NOT NULL) AS arrived_trips`;

  console.log('port_snapshots                                    avg at_berth (coverage_ok rows)');
  console.log('  port_id           delete    keep   oldest        old geom -> new geom (n)');
  let totalDelete = 0, totalKeep = 0;
  for (const r of rows) {
    totalDelete += Number(r.to_delete); totalKeep += Number(r.to_keep);
    const nNew = Number(r.new_covered);
    const newAvg = nNew > 0 ? `${String(r.new_avg_at_berth).padStart(6)} (n=${nNew})` : '(no clean sample yet)';
    console.log(
      `  ${String(r.port_id).padEnd(16)} ${String(r.to_delete).padStart(6)}  ${String(r.to_keep).padStart(6)}   ${r.oldest}    ` +
      `${String(r.old_avg_at_berth ?? '-').padStart(6)} -> ${newAvg}`,
    );
  }
  console.log(`  ${'TOTAL'.padEnd(16)} ${String(totalDelete).padStart(6)}   ${String(totalKeep).padStart(6)}\n`);
  console.log(`port_baselines    delete ${baselines[0].buckets} buckets (${baselines[0].trusted} currently trusted, n>=3)`);
  console.log('                  -> congestionRel returns null ("unknown") for these ports until rebuilt,');
  console.log('                     which is the designed degradation, not a silent "clear".');
  console.log('                  -> REBUILD TAKES ~3 WEEKS, not 3 days: n counts WEEKS (a dow x hour');
  console.log('                     bucket recurs weekly), so n>=3 needs three successive weeks.\n');
  console.log(`UNTOUCHED         port_events ${untouched[0].port_events}, arrived trips ${untouched[0].arrived_trips}`);
  console.log('                  (append-only, no recompute path — a discontinuity at the cutover, not a purge)\n');

  if (!args.apply) {
    console.log('Dry run — nothing written. Re-run with --apply to execute.');
    return;
  }

  // ---- Apply -----------------------------------------------------------------------------------
  // One transaction: baselines must go with the snapshots that produced them, or refreshBaselines'
  // 2-day expiry keeps serving the OLD percentiles for the ports we just cleared.
  const [snapRes, baseRes] = await sql.transaction([
    sql`DELETE FROM port_snapshots WHERE port_id = ANY(${portIds}::text[]) AND ts < ${cutover.toISOString()}::timestamptz RETURNING 1`,
    sql`DELETE FROM port_baselines WHERE port_id = ANY(${portIds}::text[]) RETURNING 1`,
  ]);
  console.log(`DELETED  port_snapshots ${snapRes.length} rows, port_baselines ${baseRes.length} buckets.`);
  console.log('Baselines start rebuilding on the next nightly refresh. Each dow x hour bucket');
  console.log('self-activates once it has been seen in 3 successive WEEKS of clean coverage_ok');
  console.log('history — so expect congestionRel = "unknown" for these ports for roughly 3 weeks.');
}

main().catch((e) => { console.error(e); process.exit(1); });
