-- 009: lead-time instrumentation for the two mid-voyage delay signals. Prod analysis (2026-07-16,
-- 2,243 eligible arrived trips) showed both flags separate hard on arrival lateness — stalled: 50%
-- land >2h late vs 10% baseline; ETA slip >=30min: 31.9% vs 2.9% (11x) — but neither records WHEN
-- it first fired, so "flagged voyages land late" (correlation) cannot become "we flagged it N hours
-- before arrival" (the sellable lead-time claim). Stamp both signals' first firing:
--   stalled_at       — when markStalled first set stalled=true (the eager first stall tick)
--   slip_flagged_at  — when max_eta_slip_min first reached the 30-min flag threshold
-- Lead time = arrived_at - <stamp>. Additive + nullable: historic rows stay NULL
-- ("pre-instrumentation") and are excluded from lead-time stats. Run on Neon BEFORE deploying the
-- relay that writes them (like 001-008).
ALTER TABLE trips ADD COLUMN IF NOT EXISTS stalled_at timestamptz;
ALTER TABLE trips ADD COLUMN IF NOT EXISTS slip_flagged_at timestamptz;
