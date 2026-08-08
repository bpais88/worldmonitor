# Analytics Primitives — Vessels, Trips & Per-Trip Time-Series

Status: Phase A shipped (vessel dimension); Phases B/C specced. The durable analytics layer that
turns the real-time freight board into a queryable history. Store: **Postgres** (Neon), same instance
as the port-congestion series (`assistant/PORT_CONGESTION_SCHEMA.md`). Migration:
`scripts/migrations/002_analytics.sql` (additive to 001, idempotent).

These three primitives — **per-vessel profiles**, **trips**, and **port profiles** (derived) — combined
with the congestion series are the monetizable product: "who moves what, where, and how reliably."

Design principles: freight-only (the paying audience — tankers/cruise/tourist excluded by the same
`isFreightVessel` classifier the `/ais/vessels` board uses); classification stored **auditably**
(`is_freight` + the `freight_reason` WHY); append-only time-series; the vessel dim is durable where the
relay's in-memory maps evict on staleness.

---

## Tables

### `vessels` — dimension (durable per-vessel profile) — Phase A ✅

```sql
CREATE TABLE vessels (
  mmsi           text PRIMARY KEY,
  imo            text,
  name           text,
  ship_type      integer,              -- raw AIS ship type (0-99)
  category       text,                 -- passenger | cargo | tanker | hsc | other
  is_freight     boolean NOT NULL DEFAULT false,
  freight_reason text,                 -- imo-registry | cargo-type | ropax-operator | null
  operator_id    text,
  operator_name  text,
  length_m real, beam_m real, draught_m real,
  first_seen     timestamptz NOT NULL, -- set once on insert
  last_seen      timestamptz NOT NULL  -- refreshed every sync
);
```

**Freight classification** (`freightReason` in `scripts/ferry-eta.cjs`, single source of truth) resolves,
in order: (1) verified IMO registry (Equasis per-hull) → `imo-registry`; (2) AIS ship type 70-79
(cargo/RoRo/container) → `cargo-type`; (3) ship type 60-69 (RoPax) **only** when the name matches a
freight operator → `ropax-operator`; else `null` (tankers 80-89, HSC, passenger-tourist excluded).
`isFreightVessel` = `freightReason(...) !== null`.

**Writer** (`syncVesselDim` in `scripts/ais-relay.cjs` → `db.syncVessels`): on boot + every
`VESSEL_SYNC_MS` (default 10 min), build the freight roster via `buildVesselList(..., isFreight)` and
batch-upsert. `first_seen` is set once; `last_seen` + attributes refresh on conflict; **COALESCE**
preserves a known `imo`/`name`/dimension against a later position-only frame that lacks it;
classification fields always reflect the latest.

### `trips` — one row per vessel leg toward a destination port — Phase B

```sql
CREATE TABLE trips (
  id bigserial PRIMARY KEY,
  mmsi text NOT NULL,
  origin_port_id text,                 -- null if departure wasn't observed (opened mid-sea)
  dest_port_id text NOT NULL,
  opened_at timestamptz NOT NULL,
  departed_at timestamptz,             -- geofence exit from origin
  arrived_at timestamptz,              -- geofence enter at destination (null while open)
  duration_min integer,
  dest_dwell_min real,                 -- dwell at destination (backfilled on the destination exit)
  distance_km real, avg_speed_kn real,
  departure_eta timestamptz,           -- the leg's ETA at open (for on-time scoring)
  max_eta_slip_min integer,            -- worst ETA growth over the trip (delay magnitude)
  slip_flagged_at timestamptz,         -- first bump reaching 30min slip (lead-time anchor, 009)
  stalled boolean NOT NULL DEFAULT false,
  stalled_at timestamptz,              -- first stall tick (lead-time anchor, 009)
  status text NOT NULL DEFAULT 'open', -- open | arrived | abandoned
  updated_at timestamptz NOT NULL
);
```

A trip **joins the voyage anchor to the geofence events**, anchor-owns-identity: OPENED when the
relay's `voyageByMmsi` resolves a destination (so `origin_port_id` is null until an origin exit is
observed — legs opened mid-sea have no origin); geofence `port_events` only CLOSE (`status='arrived'`
on destination-enter) and DECORATE (backfill `origin_port_id`/`departed_at`, `dest_dwell_min`).
`status` is a strict enum `open | arrived | abandoned` (arrived + abandoned are terminal); every
lifecycle write is status-guarded so any replay/restart is a 0-row no-op.

**Migration 003 hardening (Phase B prerequisite):** adds `UNIQUE INDEX uq_trips_one_open ON trips(mmsi)
WHERE status='open'` — at most one open trip per vessel, the DB-level defense `openTrip`'s
`ON CONFLICT (mmsi) WHERE status='open' DO NOTHING` relies on (002's `ix_trips_open` was non-unique).
Plus `ix_trips_status_opened` for the `loadOpenTrips`/`abandonStaleTrips` sweeps. Writer lives in
`scripts/db.cjs` (openTrip/finishTrip/appendTripPoints/loadOpenTrips/abandon*/backfill*/finalizeArrivedGeo/
pruneTripPoints), fire-and-forget from the relay, with health kept separate from the port-history writer.

**Relay wiring (behind `TRIPS_ENABLED`, default off):** OPEN + `trip_points` capture in the ferry-delay
loop; CLOSE + origin/dwell backfills in the geofence loop; periodic sweeps via `scheduleWithBootRun` —
`finalizeArrivedGeo` (~5 min, distance/avg_speed for arrived trips; **migration 004** adds
`ix_trips_arrived_unfinalized` so it's an indexed lookup) and a daily `abandonStaleTrips` +
`pruneTripPoints`. `/health.trips` surfaces open-trips-tracked, oldest-open-age (leak indicator),
buffered points, the write counters, and a `degraded` flag.

### `trip_points` — per-trip time-series (the "rich" option) — Phase B

```sql
CREATE TABLE trip_points (
  trip_id bigint NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  ts timestamptz NOT NULL,
  lat double precision, lon double precision,
  speed_kn real, course real,
  eta timestamptz,                     -- live geometric ETA at this point
  eta_slip_min integer,                -- signed ETA drift vs the recent window
  PRIMARY KEY (trip_id, ts)
);
```

---

## Derived: vessel & port profiles — Phase C

Not tables but rollups/queries over the primitives above:

- **Vessel profile** — trip count, favourite routes, on-time rate, avg dwell, from `trips` grouped by `mmsi`.
- **Port profile** — ship count, peak arrival hours (local tz), median time-to-unload (dwell), from
  `port_events` + `trips` grouped by `dest_port_id`. Complements the `port_baselines` congestion normal.

## Serving — Phase C

Marco tools (`get_vessel_profile`, `get_trip`, `get_port_profile`) + relay endpoints + ferry.html UI.
Same discipline as the congestion forecast: ship a primitive only once its data is trustworthy.

## How this maps to the roadmap

- **Phase A** → `vessels` dim + `syncVesselDim` writer + `/health` vessel stats. ✅
- **Phase B** → trips lifecycle writer (anchor + `port_events`) + `trip_points` per-tick capture.
- **Phase C** → vessel/port profile rollups + Marco tools + UI. Monetization surface.
