-- 010: disruption first-seen log — lead-time evidence for the strike-alert claim. Disruption events
-- live in relay memory only (refreshed from the MIT registry / union news / GDELT every 3h), so
-- "how far ahead did we know?" is not reconstructable: the registry shows strikes 5-105 days out
-- (observed 2026-07-16), but without a first-sighting timestamp the alert lead time can never be
-- MEASURED, only asserted. Append-only log keyed on the event id (already stable — watch dedup in
-- assistant/watches.mjs relies on it): each id is inserted once, on the refresh that first sees it.
--   lead time      = starts_at - first_seen_at            (scheduled strikes)
--   news-precedes  = calendar row's first_seen_at - matching strike_report's first_seen_at
-- Run on Neon BEFORE deploying the relay that writes it (like 001-009).
CREATE TABLE IF NOT EXISTS disruption_log (
  event_id      text PRIMARY KEY,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  kind          text NOT NULL,            -- strike_scheduled | strike_report
  country       text,
  starts_at     timestamptz,              -- null for news reports (article date != strike date)
  summary       text
);
