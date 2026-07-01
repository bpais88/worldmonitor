-- Port-Congestion Forecast — time-series schema (Neon Postgres).
-- Spec: assistant/PORT_CONGESTION_SCHEMA.md. Run once in Neon's SQL editor (or via the relay migrator).
-- Idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS ports (
  port_id     text PRIMARY KEY,
  name        text NOT NULL,
  country     text NOT NULL,
  region      text,
  lat         double precision,
  lon         double precision,
  tz          text NOT NULL,
  commercial  boolean NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS port_snapshots (
  ts          timestamptz NOT NULL,
  port_id     text NOT NULL REFERENCES ports(port_id),
  at_port     integer,
  at_port_raw integer,
  at_berth    integer,
  at_anchor   integer,
  inbound     integer,
  eta_h6 integer, eta_h12 integer, eta_h24 integer, eta_h48 integer,
  feed_label  text,
  source      text NOT NULL,
  coverage_ok boolean NOT NULL,
  PRIMARY KEY (port_id, ts)
);
CREATE INDEX IF NOT EXISTS ix_snap_port_ts ON port_snapshots (port_id, ts DESC);

CREATE TABLE IF NOT EXISTS port_events (
  ts        timestamptz NOT NULL,
  port_id   text NOT NULL REFERENCES ports(port_id),
  mmsi      text NOT NULL,
  kind      text NOT NULL,
  dwell_min real,
  source    text NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_evt_port_ts ON port_events (port_id, ts DESC);

CREATE TABLE IF NOT EXISTS port_baselines (
  port_id    text NOT NULL REFERENCES ports(port_id),
  dow        smallint NOT NULL,
  hour       smallint NOT NULL,
  p50 real, p75 real, p90 real, mean real, stddev real,
  n          integer NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (port_id, dow, hour)
);

CREATE TABLE IF NOT EXISTS forecasts (
  id           bigserial PRIMARY KEY,
  made_at      timestamptz NOT NULL,
  port_id      text NOT NULL REFERENCES ports(port_id),
  horizon_h    integer NOT NULL,
  target_ts    timestamptz NOT NULL,
  pred_at_berth real,
  pred_label   text,
  actual_at_berth real,
  actual_label text,
  abs_error    real
);
CREATE INDEX IF NOT EXISTS ix_fc_target ON forecasts (target_ts) WHERE actual_at_berth IS NULL;
CREATE INDEX IF NOT EXISTS ix_fc_port_made ON forecasts (port_id, made_at DESC);

-- Seed the ports dimension (39 commercial ports, tz per country). The relay also re-syncs
-- this from src/config/italy-ferries.data.json on boot, so this is just a convenience seed.
INSERT INTO ports (port_id, name, country, region, lat, lon, tz) VALUES
  ('algeciras', 'Algeciras', 'ES', 'Andalusia', 36.13, -5.43, 'Europe/Madrid'),
  ('amsterdam', 'Amsterdam', 'NL', 'North Holland', 52.42, 4.85, 'Europe/Amsterdam'),
  ('ancona', 'Ancona', 'IT', 'Marche', 43.62, 13.51, 'Europe/Rome'),
  ('augusta', 'Augusta', 'IT', 'Sicilia', 37.2, 15.22, 'Europe/Rome'),
  ('barcelona', 'Barcelona', 'ES', 'Catalonia', 41.35, 2.16, 'Europe/Madrid'),
  ('bari', 'Bari', 'IT', 'Puglia', 41.14, 16.87, 'Europe/Rome'),
  ('bilbao', 'Bilbao', 'ES', 'Basque Country', 43.36, -3.05, 'Europe/Madrid'),
  ('brindisi', 'Brindisi', 'IT', 'Puglia', 40.65, 17.99, 'Europe/Rome'),
  ('cagliari', 'Cagliari', 'IT', 'Sardegna', 39.21, 9.11, 'Europe/Rome'),
  ('cartagena_es', 'Cartagena', 'ES', 'Murcia', 37.58, -0.98, 'Europe/Madrid'),
  ('eemshaven', 'Eemshaven', 'NL', 'Groningen', 53.44, 6.83, 'Europe/Amsterdam'),
  ('felixstowe', 'Felixstowe', 'GB', 'England', 51.95, 1.31, 'Europe/London'),
  ('genoa', 'Genoa', 'IT', 'Liguria', 44.41, 8.9, 'Europe/Rome'),
  ('gioia_tauro', 'Gioia Tauro', 'IT', 'Calabria', 38.43, 15.9, 'Europe/Rome'),
  ('hull', 'Hull', 'GB', 'England', 53.74, -0.29, 'Europe/London'),
  ('immingham', 'Immingham', 'GB', 'England', 53.63, -0.19, 'Europe/London'),
  ('la_spezia', 'La Spezia', 'IT', 'Liguria', 44.1, 9.83, 'Europe/Rome'),
  ('liverpool', 'Liverpool', 'GB', 'England', 53.45, -3.01, 'Europe/London'),
  ('livorno', 'Livorno', 'IT', 'Toscana', 43.55, 10.3, 'Europe/Rome'),
  ('london_gateway', 'London Gateway', 'GB', 'England', 51.51, 0.49, 'Europe/London'),
  ('moerdijk', 'Moerdijk', 'NL', 'North Brabant', 51.7, 4.61, 'Europe/Amsterdam'),
  ('monfalcone', 'Monfalcone', 'IT', 'Friuli Venezia Giulia', 45.8, 13.55, 'Europe/Rome'),
  ('naples', 'Naples', 'IT', 'Campania', 40.84, 14.26, 'Europe/Rome'),
  ('olbia', 'Olbia', 'IT', 'Sardegna', 40.92, 9.51, 'Europe/Rome'),
  ('porto_marghera', 'Porto Marghera', 'IT', 'Veneto', 45.45, 12.26, 'Europe/Rome'),
  ('ravenna', 'Ravenna', 'IT', 'Emilia e Romagna', 44.48, 12.28, 'Europe/Rome'),
  ('rotterdam', 'Rotterdam', 'NL', 'South Holland', 51.95, 4.14, 'Europe/Amsterdam'),
  ('savona', 'Savona', 'IT', 'Liguria', 44.31, 8.49, 'Europe/Rome'),
  ('southampton', 'Southampton', 'GB', 'England', 50.9, -1.42, 'Europe/London'),
  ('taranto', 'Taranto', 'IT', 'Puglia', 40.47, 17.22, 'Europe/Rome'),
  ('tarragona', 'Tarragona', 'ES', 'Catalonia', 41.1, 1.22, 'Europe/Madrid'),
  ('teesport', 'Teesport', 'GB', 'England', 54.6, -1.15, 'Europe/London'),
  ('tilbury', 'Tilbury', 'GB', 'England', 51.46, 0.35, 'Europe/London'),
  ('trieste', 'Trieste', 'IT', 'Friuli Venezia Giulia', 45.64, 13.76, 'Europe/Rome'),
  ('vado_ligure', 'Vado Ligure', 'IT', 'Liguria', 44.27, 8.44, 'Europe/Rome'),
  ('valencia', 'Valencia', 'ES', 'Valencia', 39.44, -0.31, 'Europe/Madrid'),
  ('venezia', 'Venezia', 'IT', 'Veneto', 45.44, 12.34, 'Europe/Rome'),
  ('vigo', 'Vigo', 'ES', 'Galicia', 42.24, -8.73, 'Europe/Madrid'),
  ('vlissingen', 'Vlissingen', 'NL', 'Zeeland', 51.44, 3.58, 'Europe/Amsterdam')
ON CONFLICT (port_id) DO UPDATE SET
  name=EXCLUDED.name, country=EXCLUDED.country, region=EXCLUDED.region,
  lat=EXCLUDED.lat, lon=EXCLUDED.lon, tz=EXCLUDED.tz;
