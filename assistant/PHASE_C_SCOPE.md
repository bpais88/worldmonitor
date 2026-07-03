# Phase C Scope — Serving Layer (Profiles + Marco Tools + UI)

Status: scoped 2026-07-02 (8-agent design workflow). The monetization serving surface on top of the
Phase A/B data ([[ANALYTICS_SCHEMA.md]]) + the port-congestion series ([[PORT_CONGESTION_SCHEMA.md]]).
This is a PROPOSAL with owner decisions still open (see the last section).

## Architecture decision — on-demand, not materialized (at launch)

All three profiles are **on-demand parameterized queries** over the existing primitives (trips,
trip_points, vessels, ports, port_events, port_baselines) — **no new rollup tables**. Rationale:

- Data is thin (trips 1 day old, 2–4 weeks from statistical meaning). A nightly rollup would **freeze
  thin numbers** between refreshes and add a fire-and-forget scheduler that can silently fail — the
  exact frozen-profile trust-killer we can't afford. On-demand is always-fresh.
- Launch query volume is ~zero: every profile is a single-subject lookup (one mmsi / port / trip_id),
  and existing indexes already cover them (`ix_trips_mmsi`, `ix_trips_dest`; get_trip is a PK read).
  Materializing buys nothing now and only adds surface area (a migration, a scheduler, drift).

**Materialization is DEFERRED behind a measured trigger** (not a calendar date): promote to
`vessel_stats`/`port_stats` (migration 006, nightly refresh chained after `refreshBaselines`) ONLY when
on-demand p95 > ~200 ms under real paid traffic, OR a cross-fleet percentile-rank metric is needed.

## The load-bearing discipline — single-gate

The sufficiency gate is computed in **exactly one place** — the `db.cjs` query fn (`queryTrip`,
`queryVesselProfile`, `queryPortProfile`) returns raw counts **plus** the already-gated `{value, note}`.
The relay handler, Vercel proxy, Marco tool, and UI all read the pre-gated output and **never re-derive**
it. A failed gate SUPPRESSES the field with `{value:null, note:'insufficient …'}` — **never a silent 0**.
Gated-stat window = 45 rolling days; lifetime counters all-time; `windowDays` is disclosed.

## Metric catalog (gates)

**`get_trip`** (ships first; a trip is a RECORD not a sample → field-level flags, no min-N):
always show id/vessel/operator/status/ports/times/duration; `distance_km`/`avg_speed_kn` →
`'origin not observed'` (mid-sea open) or `'computing'`; `dest_dwell_min` → `'pending dest exit'`;
`track` shown only if ≥5 points (else `'sparse'` / `'track expired (90d)'`); coverage note on every response.

**`get_vessel_profile`** (identity ALWAYS, stats gated): identity (Phase A mature) + `trips_arrived_total`
always; `trips_arrived_45d` if ≥5; `median_dwell_min` if dwell_obs ≥3; `avg_speed_kn` if speed_obs ≥3
(annotated great-circle + mid-sea-excluded); `top_routes` if a route repeats ≥3 and distinct_routes ≥3;
`on_time_fraction` only if eligible ≥20 (DEFERRED to PR-5); `dormant` flag if last_arrival >7d.

**`get_port_profile`** (identity ALWAYS, live congestion REUSED): live congestion via `db.relativeCongestion`
(already gated n≥`BASELINE_MIN_DAYS`=3 → `'unknown'` not `'clear'`); `unique_vessels` if ≥5;
`recent_arrivals_7d` if ≥5; `median_dwell_min` if ≥3; `operator_mix` if arrivals ≥20; `peak_hours`
(local tz) if arrivals ≥100 (DEFERRED); coverage block always (source mix, coverage_frac, last_degraded_at).

Cross-cutting: every response carries an as-of timestamp + the feed caveat; scope stated explicitly
(**freight vessels → tracked EU commercial ports**) so nothing reads as total port throughput.

## Serving surface

- **Relay** (`scripts/ais-relay.cjs`, new handler branches, all PRIVATE behind `x-relay-key`): `/ais/trip?id=|mmsi=`
  (status-aware cache: immutable arrived/abandoned → `max-age=3600,s-maxage=86400`; open → `max-age=30`),
  `/ais/vessel-profile?mmsi=`, `/ais/port-profile?port=`.
- **Web proxies** (`api/ais-trip.js`, `api/ais-vessel-profile.js`, `api/ais-port-profile.js` via `createRelayHandler`,
  `requireApiKey:true`). **`requireApiKey` IS the paywall.**
- **Marco tools** (`assistant/tools/profiles.mjs`, NEW file; `get_trip`/`get_vessel_profile`/`get_port_profile`
  via `relayGet`, no db import; concatenated into each adapter's TOOLS array). `runAgent` unchanged.
- **UI** (`ferry.html`, extend the live board): click a vessel → trip-detail panel rendering the track on the
  existing map; vessel/port cards follow. Gated rendering mandatory — a suppressed metric shows a
  "Not enough data yet" chip, never a 0.

**Packaging:** FREE = live board + congestion badge + shareable teaser trip card (arrived/immutable trips
only). PAID = full profiles behind the `requireApiKey` proxies. The 24h forecast stays DEFERRED behind its
backtest hit-rate gate — Phase C profiles are the **bridge product**, the forecast is the eventual wedge.

## Phasing (each independently shippable)

Whole launch gated behind `/health` `trips.degraded===false` holding ≥1 week of clean Phase B first.

1. **PR-1 (ship first — `get_trip` tracer bullet):** `db.queryTrip` + relay `/ais/trip` + proxy + `profiles.mjs`
   (get_trip only) + `trip-detail.ts` + ferry.html click-to-trip track render. **No migration.** Proves the
   whole spine (relay → proxy → auth → tool → UI) on a cheap PK lookup + a shareable voyage record.
2. ~~**PR-2 (index guard)**~~ **RESOLVED 2026-07-03 → no index needed.** EXPLAIN (ANALYZE, BUFFERS) on the
   four representative shapes against prod Neon (8,579 trips / 120k points, worst-case subjects): per-mmsi
   shapes hit `ix_trips_mmsi` (0.2 ms), per-dest shapes hit `ix_trips_status_opened` (0.5–3.3 ms) — no
   seq-scan on `trips`, all ~100x under the 200 ms materialization trigger, so per the guard NO migration
   ships. Evidence + re-runnable check: `scripts/profile-queries-explain.sql` (re-run before PR-5 goes paid
   or if on-demand p95 creeps toward the trigger).
3. **PR-3 (`get_vessel_profile`, ~2wk accrual):** on-demand, gates in the fn. Identity always ships.
4. **PR-4 (`get_port_profile`, baselines warm n≥3):** reuses `relativeCongestion` + coverage_frac + gated aggregates.
5. **PR-5 (metric unlock, ~4wk+):** on_time / peak_hours / arrivals_per_day unlock as gates clear; add the
   3 tools to the tool-grounding eval; shareable arrived-trip deep-links + free/paid split.
6. **PR-6 (materialize — ONLY if the trigger fires):** migration 006 vessel_stats/port_stats + nightly refresh +
   staleness flag + /health.profiles. May never be needed.

## Open decisions (need the owner)

1. ~~**Distance method**~~ **RESOLVED 2026-07-02 → trip_points path-integral** (migration 005). The full-cycle
   check found origin is observed on only ~5% of trips, so great-circle-from-origin covered just 4/142 arrived
   trips; the path-integral (sailed distance from the stored points, GPS-jump legs > 40 kn dropped) lifts
   coverage to ~73%. `avg_speed_kn` = mean AIS speed while under way (not distance/time, which conflated
   cruising with port idle). Both reproducible from the durable points.
2. ~~**trip_points as a sold artifact**~~ **RESOLVED 2026-07-03 → keep arrived, prune abandoned.**
   Voyage replay shipped (#82), so arrived-trip points are the sold route-history artifact and are kept
   forever; abandoned-trip points still prune at 90d (`pruneTripPoints` now filters `status='abandoned'`).
   Volume is tiny (120k points at decision time) — month-partitioning deferred until the table is in the
   millions of rows. Arrived trips pruned under the old policy show `'sparse; 0 waypoints'`, self-healing
   as new voyages accrue.
3. **coverageOk weighting** — suppress a metric computed over a window with degraded snapshots, or show with
   a discount/caveat? What coverage_frac threshold (~0.95?) flips the port 'degraded coverage' flag?
4. **Materialize trigger + owner** — confirm the p95>200ms / cross-fleet-percentile rule + who watches it.
5. **on_time tolerance** — fix +15 min fleet-wide, or per-operator/configurable?
6. **Pricing / packaging** — is the all-or-nothing `requireApiKey` boundary OK for launch, or do we need
   per-tier metering / entitlements before selling?
7. **Launch-gate sign-off** — who confirms `trips.degraded===false` held ≥1 week + a sane daily trip-count
   trend before profiles go paid?
8. **Operator-level scorecards** (e.g. "Grimaldi's on-time rate") — in Phase C or explicitly deferred?
   (cross-subject aggregation + commercial sensitivity of benchmarking named operators.)
9. **24h forecast** — confirmed DEFERRED out of Phase C serving until the backtest hit-rate gate passes.
