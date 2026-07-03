-- On-time integrity (Phase C PR-5 review catch): `departure_eta` holds EITHER the ETA declared at
-- voyage open (openTrip) OR the first ETA observed mid-voyage (patchTripEta fills a NULL later —
-- trip-lifecycle.cjs decideTrip 'patchEta'). The sold on_time_fraction must only score the promise
-- made AT OPEN: a mid-voyage ETA (possibly minutes before arrival) is a trivially-keepable promise
-- and inflates reliability. Stamp provenance at write time; the metric filters on it.
-- Idempotent; safe to re-run. Apply manually to Neon BEFORE merging the code that reads it (like 003/004/005).
ALTER TABLE trips ADD COLUMN IF NOT EXISTS eta_at_open boolean NOT NULL DEFAULT false;

-- Historical rows: at-open vs patched is NOT reconstructable from the data → conservatively false
-- (pre-migration trips are excluded from on-time eligibility). Only affects trips opened before
-- 2026-07-03; the ≥20-eligible-per-vessel gate is weeks out regardless, so nothing user-visible
-- changes. departure_eta itself is untouched — it still feeds the get_trip onTime display and slip.
