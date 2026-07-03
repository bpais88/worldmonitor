-- Phase C PR-2 index guard: EXPLAIN the per-mmsi / per-dest 45d profile queries
-- (the query shapes PR-3 `get_vessel_profile` and PR-4 `get_port_profile` will run).
-- Spec: assistant/PHASE_C_SCOPE.md phasing item 2. Re-run when the materialization
-- trigger is suspected (on-demand p95 > ~200 ms) or before PR-5 goes paid:
--
--   psql "$DATABASE_URL" -v mmsi=<busiest_mmsi> -v dest=<busiest_port> -f scripts/profile-queries-explain.sql
--
-- Pick worst-case subjects first — with the SAME status/window predicates as the profiled shapes
-- below, so once the table holds >45d of history (or traffic shifts) the picker can't hand the guard
-- an all-time-busiest subject that is low-cardinality inside the actual 45d arrived window:
--   SELECT mmsi, count(*) FROM trips
--     WHERE status='arrived' AND opened_at >= now() - interval '45 days'
--     GROUP BY 1 ORDER BY 2 DESC LIMIT 1;
--   SELECT dest_port_id, count(*) FROM trips
--     WHERE status='arrived' AND opened_at >= now() - interval '45 days'
--     GROUP BY 1 ORDER BY 2 DESC LIMIT 1;
--
-- Verdict 2026-07-03 (8,579 trips / 120k trip_points; subjects picked WITH the arrived+45d
-- predicates: mmsi 563279500 = 19 arrived-in-window, dest rotterdam = 139 arrived-in-window):
-- NO seq-scan on trips in any shape → per the spec, NO covering index added. V1/V2 hit
-- ix_trips_mmsi (mmsi + opened_at both as index conditions), 0.2 ms. P1/P2 hit
-- ix_trips_status_opened (planner prefers the status+window index over ix_trips_dest at
-- current cardinalities; either is fine — it will switch as dest selectivity improves),
-- 0.5–3.4 ms. The vessels seq-scan in P2 is the hash-join build side over the whole (small)
-- vessels table, not a guarded trips scan. All ~100x under the 200 ms materialization trigger.

\echo '=== V1: vessel 45d aggregate (get_vessel_profile)'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
SELECT count(*) FILTER (WHERE status='arrived')                      AS arrived_45d,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY dest_dwell_min)   AS median_dwell,
       avg(avg_speed_kn)                                             AS avg_speed
FROM trips
WHERE mmsi = :'mmsi' AND opened_at >= now() - interval '45 days';

\echo '=== V2: vessel top_routes GROUP BY (get_vessel_profile)'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
SELECT origin_port_id, dest_port_id, count(*)
FROM trips
WHERE mmsi = :'mmsi' AND status = 'arrived' AND opened_at >= now() - interval '45 days'
GROUP BY 1, 2 ORDER BY count(*) DESC LIMIT 5;

\echo '=== P1: port 45d aggregate (get_port_profile)'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
SELECT count(DISTINCT mmsi)                                          AS unique_vessels,
       count(*) FILTER (WHERE arrived_at >= now() - interval '7 days') AS arrivals_7d,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY dest_dwell_min)   AS median_dwell
FROM trips
WHERE dest_port_id = :'dest' AND status = 'arrived' AND opened_at >= now() - interval '45 days';

\echo '=== P2: port operator_mix GROUP BY (get_port_profile)'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
SELECT v.operator_id, count(*)
FROM trips t JOIN vessels v ON v.mmsi = t.mmsi
WHERE t.dest_port_id = :'dest' AND t.status = 'arrived' AND t.opened_at >= now() - interval '45 days'
GROUP BY 1 ORDER BY count(*) DESC;
