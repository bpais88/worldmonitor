-- Support the finalizeArrivedGeo sweep (Phase B PR5): it fills distance_km/avg_speed_kn for
-- freshly-arrived trips that have a known origin, on a periodic cadence. A partial index over exactly
-- that unfinalized set turns the sweep into an indexed lookup (usually 0 rows) instead of a seq-scan
-- of the trips table. Spec: assistant/ANALYTICS_SCHEMA.md. Idempotent; safe to re-run.
CREATE INDEX IF NOT EXISTS ix_trips_arrived_unfinalized ON trips (id)
  WHERE status = 'arrived' AND distance_km IS NULL;
