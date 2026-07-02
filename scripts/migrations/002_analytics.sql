-- Analytics primitives (monetization): vessel profiles, trips, per-trip time-series.
-- Spec: assistant/ANALYTICS_SCHEMA.md. Additive to 001 (port-history). Idempotent; safe to re-run.

-- Vessel dimension: a durable profile per vessel (memory maps evict on staleness; this persists).
-- Freight classification is stored explicitly + auditably (is_freight + why).
CREATE TABLE IF NOT EXISTS vessels (
  mmsi           text PRIMARY KEY,
  imo            text,
  name           text,
  ship_type      integer,              -- raw AIS ship type
  category       text,                 -- passenger | cargo | tanker | hsc | other
  is_freight     boolean NOT NULL DEFAULT false,
  freight_reason text,                 -- imo-registry | cargo-type | ropax-operator | null
  operator_id    text,
  operator_name  text,
  length_m       real,
  beam_m         real,
  draught_m      real,
  first_seen     timestamptz NOT NULL,
  last_seen      timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_vessels_operator ON vessels (operator_id);
CREATE INDEX IF NOT EXISTS ix_vessels_category ON vessels (category);

-- Trips: one row per vessel leg toward a destination port. Opened on destination-resolve +
-- origin-exit, closed on destination-enter (joins the voyage anchor to the geofence events).
CREATE TABLE IF NOT EXISTS trips (
  id             bigserial PRIMARY KEY,
  mmsi           text NOT NULL,
  origin_port_id text,                 -- null if departure wasn't observed (opened mid-sea)
  dest_port_id   text NOT NULL,
  opened_at      timestamptz NOT NULL, -- when the anchor/leg opened
  departed_at    timestamptz,          -- geofence exit from origin
  arrived_at     timestamptz,          -- geofence enter at destination (null while open)
  duration_min   integer,              -- arrived_at − departed_at (or − opened_at)
  dest_dwell_min real,                 -- dwell at destination (backfilled on the destination exit)
  distance_km    real,                 -- great-circle origin→dest
  avg_speed_kn   real,
  departure_eta  timestamptz,          -- the leg's ETA at open (for on-time scoring)
  max_eta_slip_min integer,            -- worst ETA growth over the trip (delay magnitude)
  stalled        boolean NOT NULL DEFAULT false,
  status         text NOT NULL DEFAULT 'open',   -- open | arrived | abandoned
  updated_at     timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_trips_mmsi ON trips (mmsi, opened_at DESC);
CREATE INDEX IF NOT EXISTS ix_trips_dest ON trips (dest_port_id, opened_at DESC);
CREATE INDEX IF NOT EXISTS ix_trips_open ON trips (mmsi) WHERE status = 'open';

-- Per-trip time-series (the "rich" option): position/speed/ETA sampled along the trip.
CREATE TABLE IF NOT EXISTS trip_points (
  trip_id      bigint NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  ts           timestamptz NOT NULL,
  lat          double precision,
  lon          double precision,
  speed_kn     real,
  course       real,
  eta          timestamptz,            -- live geometric ETA at this point
  eta_slip_min integer,                -- signed ETA drift vs the recent window
  PRIMARY KEY (trip_id, ts)
);
