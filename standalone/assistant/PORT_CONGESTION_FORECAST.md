# Port-congestion forecast — plan + backtest reminder

**Goal:** a sellable "will this port be congested in ~24h" forecast. We log real
ground truth first, then backtest, then ship only the horizons that score.

## Status

- **Collection started 2026-07-01** — `/ais/port-history` banking per-port snapshots
  + geofence enter/exit/dwell events (durable in Upstash, survives restarts).
- **PR-1 (shipped):** the ETA engine — `computePortStatus` now emits `inboundEta`
  (geometric-ETA arrival buckets) + `atAnchor`/`atBerth`.
- **PR-2 (next):** Ports-tab "inbound view" — `⚓ Waiting` (atAnchor) column +
  `Arrivals · next 24h` (inboundEta). Frontend-only; data already on `/ais/ports`.
- **PR-3 (~mid-July 2026 — DO THE BACKTEST):** validate + ship the congestion call.

## The backtest (PR-3, do ~2 weeks after 2026-07-01)

Replay: at each past time **T**, forecast **T+24h using only data available at T**,
then compare to what actually happened at T+24h.

- **Model (mass-balance):** `atPort(+24h) ≈ atPort(now) + arrivals_within_24h −
  departures(clearance_rate × 24h)`, blended with a per-port day-of-week × hour baseline.
  - `arrivals_within_24h` = `inboundEta.h24` (logged by PR-1)
  - `clearance_rate` = departures/hour from the geofence exit events + dwell
  - `baseline` = learned from the `atPort` series — a **relative** congestion definition
    ("busy for THIS port"), since the fixed ≥8 rule mislabels mega-ports
    (Rotterdam/Amsterdam sit at ~50 permanently).
- **Score:** hit-rate on the busy/congested label, MAE on the count, useful lead time.
- **Gate:** ship 24h only if it clears a bar (e.g. >75% hit-rate); if only 6–12h clears,
  ship that and say so. Never ship a horizon that didn't earn it.

## Data logged for this (per 5-min snapshot, per portId)

`{ atPort (smoothed), atPortRaw, atAnchor, atBerth, inbound, inboundEta:{h6,h12,h24,h48},
congestion }` + geofence events `{ mmsi, kind: enter|exit, dwellMin }`. Served at
`/ais/port-history`.

## Then (the product)

Ports-tab "Next 24h" forecast column + Marco `forecast_port_congestion` tool +
proactive "congestion ahead" watch alerts (the flagship sellable surface — fires
before it happens, with a real hit-rate). Honesty contract: inbound-view now,
scored congestion-call after this backtest.
