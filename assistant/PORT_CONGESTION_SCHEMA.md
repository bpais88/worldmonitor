# Port-Congestion Forecast — Time-Series Schema, Writer & Rollup Spec

Status: spec (2026-07-01). The durable home for the monetizable forecast. Replaces the Upstash
single-blob port-history (which silently caps ~1 MB/~1 day). Store: **Postgres** (Neon or Supabase —
both HTTP-driver-friendly, matching the relay's existing REST persistence). Redis stays for HOT state
(live `/ais/ports` served from memory); Postgres is the durable time-series sink + query engine.

Design principles: append-only; narrow+indexed; **provenance on every row** (so the backtest can
exclude degraded feed data); **baselines bucketed in LOCAL port time** (congestion follows local
working hours); a **`forecasts` table** so the backtest gate is a query.

---

## Tables

### `ports` — dimension (synced from src/config/italy-ferries.data.json on deploy)

```sql
CREATE TABLE ports (
  port_id     text PRIMARY KEY,
  name        text NOT NULL,
  country     text NOT NULL,           -- 'IT' | 'GB' | 'ES' | 'PT' | 'NL'
  region      text,
  lat         double precision,
  lon         double precision,
  tz          text NOT NULL,           -- IANA, e.g. 'Europe/Rotterdam' — derived per country
  commercial  boolean NOT NULL DEFAULT true
);
```
`tz` per country (all 5 are single-zone for our ports): IT→Europe/Rome, GB→Europe/London,
ES→Europe/Madrid, PT→Europe/Lisbon, NL→Europe/Amsterdam. Add a `tz` field to the JSON (or map country→tz at sync).

### `port_snapshots` — raw time-series (append-only, one row per port per tick)

```sql
CREATE TABLE port_snapshots (
  ts          timestamptz NOT NULL,    -- UTC sample time
  port_id     text NOT NULL REFERENCES ports(port_id),
  at_port     integer,                 -- stopped within 8km (smoothed)
  at_port_raw integer,                 -- pre-smoothing
  at_berth    integer,                 -- navStatus=moored/berthed  ← the clean occupancy signal
  at_anchor   integer,                 -- navStatus=at anchor
  inbound     integer,                 -- under way, bound here
  eta_h6      integer, eta_h12 integer, eta_h24 integer, eta_h48 integer,  -- cumulative inbound-ETA buckets
  feed_label  text,                    -- the relay's raw label at capture (reference only)
  source      text NOT NULL,           -- 'aisstream' | 'marinesia' | 'mixed'
  coverage_ok boolean NOT NULL,        -- did THIS port have live coverage this tick?
  PRIMARY KEY (port_id, ts)            -- idempotent: retries upsert, never double-count
);
CREATE INDEX ix_snap_port_ts ON port_snapshots (port_id, ts DESC);
```
Cadence: **5-min rows** (≈11k rows/day for 39 ports — trivial for PG; 60s would be 5× for no
forecast benefit). Congestion is DERIVED downstream (relative), not trusted from `feed_label`.

### `port_events` — geofence crossings

```sql
CREATE TABLE port_events (
  ts        timestamptz NOT NULL,
  port_id   text NOT NULL REFERENCES ports(port_id),
  mmsi      text NOT NULL,
  kind      text NOT NULL,             -- 'enter' | 'exit'
  dwell_min real,                      -- set on 'exit' (enter→exit pair), null on 'enter'
  source    text NOT NULL
);
CREATE INDEX ix_evt_port_ts ON port_events (port_id, ts DESC);
```

### `port_baselines` — precomputed per-port × local-dow × local-hour (the "normal")

```sql
CREATE TABLE port_baselines (
  port_id    text NOT NULL REFERENCES ports(port_id),
  dow        smallint NOT NULL,        -- 0..6 in LOCAL port time
  hour       smallint NOT NULL,        -- 0..23 in LOCAL port time
  p50 real, p75 real, p90 real, mean real, stddev real,  -- of at_berth
  n          integer NOT NULL,         -- DISTINCT local days observed (trust gate; percentiles are over all samples)
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (port_id, dow, hour)
);
```

### `forecasts` — predictions + later-filled actuals (the backtest gate, as data)

```sql
CREATE TABLE forecasts (
  id           bigserial PRIMARY KEY,
  made_at      timestamptz NOT NULL,
  port_id      text NOT NULL REFERENCES ports(port_id),
  horizon_h    integer NOT NULL,       -- e.g. 24
  target_ts    timestamptz NOT NULL,   -- made_at + horizon
  pred_at_berth real,
  pred_label   text,                   -- clear|busy|congested (relative)
  actual_at_berth real,                -- filled when target_ts passes
  actual_label text,
  abs_error    real
);
CREATE INDEX ix_fc_target ON forecasts (target_ts) WHERE actual_at_berth IS NULL;  -- fill-in job
CREATE INDEX ix_fc_port_made ON forecasts (port_id, made_at DESC);
```

---

## Writer (relay side)

Every sample tick (5 min), `computePortStatus` already yields the per-port fields. The writer:

1. Builds ~39 rows (all covered ports) + tags `source` and `coverage_ok` per row — **depends on the
   feed source/region provenance** (P1 item; the same signal that powers the honesty caveat).
2. **One batched INSERT** for all ports: `INSERT ... ON CONFLICT (port_id, ts) DO UPDATE` (idempotent).
3. Geofence `diffMembership` enter/exit → batched INSERT into `port_events` (dwell on exit).
4. **Loud on failure** — log + a `/health` `portHistory` block (`rowsToday`, `lastWriteOk`,
   `lastWriteAt`, `lastError`). Never silent (the current blocker). Never blocks the sample loop —
   on failure, queue/retry.
5. Redis unchanged for hot state; the old `relay:port-history:v1` blob is retired; `/ais/port-history`
   is re-pointed to query `port_snapshots` with `?since=/?limit=/?ports=`.

## Rollup + serving

**Baseline refresh** (scheduled, e.g. nightly) — LOCAL-time bucketed, degraded rows excluded. This
snippet mirrors `refreshBaselines()` in `scripts/db.cjs` (the runnable source of truth); keep them in
sync. Note `n` = **DISTINCT local days**, not `count(*)` — cadence-independent, so six adjacent 5-min
samples from one hour can't trip the trust gate:
```sql
INSERT INTO port_baselines (port_id, dow, hour, p50, p75, p90, mean, stddev, n, updated_at)
SELECT s.port_id,
       EXTRACT(dow  FROM s.ts AT TIME ZONE p.tz)::smallint,
       EXTRACT(hour FROM s.ts AT TIME ZONE p.tz)::smallint,
       percentile_cont(0.5)  WITHIN GROUP (ORDER BY s.at_berth),
       percentile_cont(0.75) WITHIN GROUP (ORDER BY s.at_berth),
       percentile_cont(0.90) WITHIN GROUP (ORDER BY s.at_berth),
       avg(s.at_berth), stddev_pop(s.at_berth),
       count(DISTINCT (s.ts AT TIME ZONE p.tz)::date), now()   -- n = distinct local days (trust gate)
FROM port_snapshots s JOIN ports p USING (port_id)
WHERE s.coverage_ok AND s.at_berth IS NOT NULL AND s.ts > now() - interval '8 weeks'
GROUP BY 1,2,3
ON CONFLICT (port_id, dow, hour) DO UPDATE SET
  p50=EXCLUDED.p50, p75=EXCLUDED.p75, p90=EXCLUDED.p90,
  mean=EXCLUDED.mean, stddev=EXCLUDED.stddev, n=EXCLUDED.n, updated_at=EXCLUDED.updated_at;
-- Then expire buckets that aged out of the 8-week window (not upserted this run):
DELETE FROM port_baselines WHERE updated_at < now() - interval '2 days';
```

**Relative congestion NOW** (replaces the absolute `atPort≥8`): compare current `at_berth` to that
port's baseline bucket → `> p90` congested, `> p75` busy, else clear. `n < BASELINE_MIN_DAYS` (≥3
distinct local days) → `unknown` — so a bucket self-activates only after real history (~weeks), never
after 30 min of one hour. No live coverage → `unknown` (never a false "clear").

**Forecast (+24h)**: dwell-aware equilibrium blended toward `baseline[port][target dow,hour]`, using
`eta_h24` for arrivals and mean dwell (from `port_events`) for departures. Write a `forecasts` row.

**Backtest fill-in** (when `target_ts` passes): set `actual_at_berth` from the `port_snapshots` row
nearest `target_ts`, compute `abs_error` + `actual_label`.

**Hit-rate gate** (the go/no-go for monetizing):
```sql
SELECT horizon_h,
       avg((pred_label = actual_label)::int)              AS label_hit_rate,
       avg(abs_error)                                     AS mae,
       count(*)                                           AS n
FROM forecasts WHERE actual_at_berth IS NOT NULL
GROUP BY horizon_h;
```

## Retention

Keep raw `port_snapshots` ~90 days (≈1M rows — nothing for PG); `DELETE` older on a schedule. Baselines
and forecasts are tiny; keep indefinitely. Downsampling to hourly is unnecessary at this volume.

## How this maps to the roadmap

- **P0 durability** → this schema + writer (retires the blob) + `/health` block.
- **P0 honest coverage** → `coverage_ok`/`source` columns + `unknown` on no-coverage.
- **P0 relative congestion** → `port_baselines` + the percentile compare.
- **P1 model** → equilibrium forecast → `forecasts`; **backtest gate** = the hit-rate query.
- Local-time bucketing (tz) is baked in from row zero, so the baseline is never smeared across zones.
