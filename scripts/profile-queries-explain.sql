-- Phase C PR-2 index guard: EXPLAIN the per-mmsi / per-dest 45d profile queries
-- (the query shapes `get_vessel_profile` (PR-3) and `get_port_profile` (PR-4) run in db.cjs).
-- Spec: assistant/PHASE_C_SCOPE.md phasing item 2. Re-run when the materialization
-- trigger is suspected (on-demand p95 > ~200 ms) or before PR-5 goes paid:
--
--   psql "$DATABASE_URL" -v mmsi=<busiest_mmsi> -v dest=<busiest_port> -f scripts/profile-queries-explain.sql
--
-- Pick worst-case subjects first — with the SAME status/window predicates as the profiled shapes
-- below, so once the table holds >45d of history (or traffic shifts) the picker can't hand the guard
-- an all-time-busiest subject that is low-cardinality inside the actual 45d arrived window:
--   SELECT mmsi, count(*) FROM trips
--     WHERE status='arrived' AND arrived_at >= now() - interval '45 days'
--     GROUP BY 1 ORDER BY 2 DESC LIMIT 1;
--   SELECT dest_port_id, count(*) FROM trips
--     WHERE status='arrived' AND arrived_at >= now() - interval '45 days'
--     GROUP BY 1 ORDER BY 2 DESC LIMIT 1;
--
-- NOTE: the profile window anchors on arrived_at (an arrival counts when it ARRIVED in-window, even
-- if the voyage opened before it — review catch on PR-3). arrived_at is in NO index; the per-mmsi /
-- per-dest index PREFIX carries the selectivity and the window is a post-filter, which is exactly
-- what this guard verifies stays off a seq-scan.
--
-- Verdict 2026-07-03 (~8.6k trips / 120k+ trip_points; subjects picked WITH the arrived+45d
-- predicates: mmsi 563279500 = 19 arrived-in-window, dest rotterdam = 155 arrived-in-window):
-- NO seq-scan on trips in any shape → per the spec, NO covering index added. V1/V2 hit
-- ix_trips_mmsi (mmsi prefix; window post-filtered), ~0.2 ms. P1/P2 hit ix_trips_status_opened
-- (status prefix; planner prefers it over ix_trips_dest at current cardinalities — either is fine,
-- it will switch as dest selectivity improves), 0.6–0.9 ms. The vessels seq-scan in P2 is the
-- hash-join build side over the whole (small) vessels table, not a guarded trips scan. All ~100x
-- under the 200 ms materialization trigger.

\echo '=== V1: vessel 45d aggregate (get_vessel_profile)'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
SELECT count(*) FILTER (WHERE status = 'arrived')                    AS arrived_total,
       count(*) FILTER (WHERE status = 'arrived'
         AND arrived_at >= now() - interval '45 days')               AS arrived_45d,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY dest_dwell_min)
         FILTER (WHERE status = 'arrived'
           AND arrived_at >= now() - interval '45 days')             AS median_dwell,
       avg(avg_speed_kn) FILTER (WHERE status = 'arrived'
         AND arrived_at >= now() - interval '45 days')               AS avg_speed
FROM trips
WHERE mmsi = :'mmsi';

\echo '=== V2: vessel top_routes GROUP BY (get_vessel_profile)'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
SELECT origin_port_id, dest_port_id, count(*)
FROM trips
WHERE mmsi = :'mmsi' AND status = 'arrived' AND origin_port_id IS NOT NULL
  AND arrived_at >= now() - interval '45 days'
GROUP BY 1, 2 ORDER BY count(*) DESC LIMIT 5;

\echo '=== P1: port 45d aggregate (get_port_profile)'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
SELECT count(DISTINCT mmsi)                                          AS unique_vessels,
       count(*) FILTER (WHERE arrived_at >= now() - interval '7 days') AS arrivals_7d,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY dest_dwell_min)   AS median_dwell
FROM trips
WHERE dest_port_id = :'dest' AND status = 'arrived' AND arrived_at >= now() - interval '45 days';

\echo '=== P2: port operator_mix GROUP BY (get_port_profile)'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
SELECT v.operator_id, count(*)
FROM trips t JOIN vessels v ON v.mmsi = t.mmsi
WHERE t.dest_port_id = :'dest' AND t.status = 'arrived' AND t.arrived_at >= now() - interval '45 days'
GROUP BY 1 ORDER BY count(*) DESC;
