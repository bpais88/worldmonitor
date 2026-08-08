-- 008: abandonment cause instrumentation. 5-day prod data (2026-07-12) showed 93% of trips end
-- abandoned with no recorded cause — root-caused to anchor-loss fragmentation, but only via ad-hoc
-- successor-trip archaeology. Stamp the cause at abandon time so the split (anchor_lost / reroute /
-- max_open_age) is one GROUP BY away, and the anchor-grace fix's effect is directly measurable.
-- Additive + nullable: historic rows stay NULL ("pre-instrumentation"). Run on Neon BEFORE deploying
-- the relay that writes it (like 001-006). 007 is reserved (materialization, PHASE_C_SCOPE PR-6).
ALTER TABLE trips ADD COLUMN IF NOT EXISTS abandon_reason text;
