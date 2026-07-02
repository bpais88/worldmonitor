-- Trips lifecycle hardening (Phase B prerequisite). Spec: assistant/ANALYTICS_SCHEMA.md.
-- Enforce ONE open trip per vessel at the DB level. Migration 002 created ix_trips_open as a
-- NON-unique partial index, so there is zero double-open defense — and double-open is the #1
-- data-quality bug for the monetized trips table. The Phase B writer's no-double-open guarantee
-- depends on the unique index below.
-- Idempotent; safe to re-run. Apply manually to Neon (like 001/002 — no runner in repo).

-- Step 1: de-dup any pre-existing duplicate open trips so the UNIQUE index can build on a dirty
-- table — keep the earliest (MIN(id)) open trip per vessel, abandon the rest. No-op on a clean table.
UPDATE trips t SET status = 'abandoned', updated_at = now()
WHERE t.status = 'open'
  AND t.id <> (SELECT min(t2.id) FROM trips t2 WHERE t2.mmsi = t.mmsi AND t2.status = 'open');

-- Step 2: replace the non-unique partial index with a UNIQUE one — the double-open backstop that
-- openTrip's `ON CONFLICT (mmsi) WHERE status='open' DO NOTHING` relies on for inference.
DROP INDEX IF EXISTS ix_trips_open;
CREATE UNIQUE INDEX IF NOT EXISTS uq_trips_one_open ON trips (mmsi) WHERE status = 'open';

-- Step 3: support the recurring lifecycle sweeps — loadOpenTrips (status IN (…) ORDER BY opened_at)
-- and abandonStaleTrips (status='open' AND opened_at < …). (pruneTripPoints already joins trip_points
-- by its PK's leading trip_id column, so no trip_points-side index is needed.)
CREATE INDEX IF NOT EXISTS ix_trips_status_opened ON trips (status, opened_at);
