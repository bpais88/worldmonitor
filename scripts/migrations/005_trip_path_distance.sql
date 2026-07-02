-- Phase C: switch trip distance/speed from great-circle-origin→dest to a trip_points PATH-INTEGRAL.
-- The full-cycle check (2026-07-02) found origin is observed on only ~5% of trips (most open mid-sea),
-- so great-circle-from-origin filled distance for just 4/142 arrived trips. The path-integral computes
-- sailed distance from the actual positions we already store (points for ~1900 trips), lifting coverage
-- to ~73% AND giving real sailed distance (not the straight line). Spec: assistant/PHASE_C_SCOPE.md #1.
-- Idempotent; safe to re-run.

-- 1) finalizeArrivedGeo no longer requires a known origin, so its supporting index must drop the
--    origin_port_id predicate (else it excludes exactly the origin-less trips we now finalize).
DROP INDEX IF EXISTS ix_trips_arrived_unfinalized;
CREATE INDEX IF NOT EXISTS ix_trips_arrived_unfinalized ON trips (id)
  WHERE status = 'arrived' AND distance_km IS NULL;

-- 2) Reset the few great-circle distances already written so EVERY arrived trip is recomputed under the
--    one path-integral definition (a sold metric must not mix two definitions). The relay's finalize
--    sweep refills them from the track. Derived columns only — no source data touched.
UPDATE trips SET distance_km = NULL, avg_speed_kn = NULL WHERE status = 'arrived' AND distance_km IS NOT NULL;
