# Feature-parity manifest — standalone freight app

Every feature of the ferry/freight product, with HOW each is verified in the standalone
repo. Nothing gets ticked by assumption: each row is closed by a moved test suite (T),
a parity diff against the old deployment (P), or a manual smoke (S).

Legend: [x] verified in this scaffold · [ ] open · (T/P/S) = verification method

## 1. Backend modules (moved as-is, their tests are the proof)

- [x] (T) Port status: atPort/atAnchor/atBerth, ETA buckets h6-h48, per-port radius + thresholds — `port-status.test.cjs`
- [x] (T) Geofences: enter/exit/dwell, radius parity with port-status — `geofence-engine.test.cjs`
- [x] (T) Marinesia fallback: per-country tiles, normalization, coverage — `marinesia.test.cjs`
- [x] (T) ETA + destination resolution (LOCODE + names) — `ferry-eta.test.cjs`, `eta-history.test.cjs`
- [x] (T) Delay detection + explainers (weather, news, meteoalarm, cross-vessel, port congestion) — 6 suites
- [x] (T) Trips lifecycle (open/close/abandon/resume) — `trip-lifecycle.test.cjs`
- [x] (T) Disruptions: strikes (MIT/GDELT/unions), water levels, chokepoints — `strike-sources.test.cjs`, `water-levels.test.cjs`, `chokepoint-markets.test.cjs`
- [x] (T) Country registry parity gates (sources, tz, aisFallback vs tile geometry) — `country-sources.test.cjs`
- [x] (T) DB layer + baselines — `db` usage covered via suites; migrations/ moved (S: run against fresh Postgres before cutover)
- [x] (T) SAR occupancy, corridor report, vessels query, AIS keys — respective suites
- Total moved backend suites green here: **285/285**

## 2. Relay HTTP service — WRITTEN (clean-room), live parity still open

`relay.cjs` + `relay-http.cjs` + `vessel-store.cjs` replace the upstream-licensed entry.
Contract fidelity came from characterization: the predecessor was booted locally and its
observable behaviour captured into `relay-http.test.cjs` (16 tests).

- [x] (T) GET /ais/ports (congestion + congestionRel + coverageOk + uncoveredPorts)
- [x] (T) GET /ais/vessels (+ freight filter, limit, bbox, operator)
- [x] (T) GET /ais/geofences (per-port radius reaches the geofence layer)
- [x] (T) GET /ais/trip · /ais/vessel-profile · /ais/port-profile · /ais/port-series (db-less shapes)
- [x] (T) GET /ais/voyages/daily · /ais/disruptions (+ country filter)
- [x] (T) GET /health · /metrics
- [x] (T) auth matrix, CORS, preflight, 405/404, gzip
- [x] (T) SECURITY: fail-closed — no secret means refuse to boot; wrong/empty/prefix keys 401
- [x] (T) DIVERGENCE: the 10 fork tenant endpoints return 404 by design
- [x] (P) **Parity harness written AND run** — `scripts/parity-diff.cjs` replays 15 requests at
      both relays and diffs the JSON. Run locally with the fork's relay on :3999 and this one on
      :3004 (both keyless/degraded): **15/15 identical, 0 differing**. Every remaining difference
      is in an explicit ACCEPTED list with a written reason, so real drift stays loud.
      It caught four things characterization missed, because the contract I wrote down was
      simply wrong in places:
        · /health had lost `portHistory` and `trips` — the blocks assistant/ops-report.mjs
          renders directly. The 10-minute freight monitor would have printed "undefined".
        · marinesia.upserts/stale/warming/ageSec were gone — the exact fields that exist because
          a dead fallback went unnoticed for ten days in 2026-07.
        · cache-control drift on /ais/port-history, /ais/voyages/daily and /ais/trip (CDN
          staleness is part of the contract).
        · port history was empty for the first 60s after every restart — no boot snapshot.
- [ ] (P) Re-run the harness against the DEPLOYED relay before cutover. The local run proves
      shape and headers; only production proves behaviour under live AIS + Postgres.
- [ ] (S) Background-job soak with real keys: aisstream reconnect, Marinesia sweep vs the
      2000/tile cap, baseline refresh.
- [ ] **NOT PORTED — trips lifecycle (Phase B).** decideTrip / planGeofenceActions / trip_points
      writing does not run in this entry. /health reports `trips.notPorted: true` rather than
      pretending. Affects /ais/trip data, get_voyage_stats and dwell/origin backfill. It was
      TRIPS_ENABLED-gated and off by default, so nothing regresses today — but it is a feature
      gap, not a parity detail, and it is the next real chunk of work.

## 3. Marco (moved wholesale)

- [x] (T) Agent loop, guardrails, grounding, coverage prose gates, watches, ops report,
      send seam, per-channel verify (Slack/Teams/Telegram-bot/WhatsApp/voice) — **155/155** here
- [ ] (S) Live channel smoke per platform after deploy (webhook URLs re-pointed)
- [ ] (S) assistant/railway.json deployed as its own service in new infra

## 4. Frontend (moved + 3 clean-room rewrites)

- [x] (S) Builds + typechecks (0 errors) with clean-room Panel/sanitize/i18n and fresh vite config
- [ ] (S) Visual smoke: board renders, map tiles, region tabs, vessel popup, replay controls
- [x] (S) Playwright smoke spec — 4 tests against the REAL relay + a production build:
      board mounts, Ports view loads live rows, empty fleet renders an empty state
      (not a crash or an invented count), map host + bundle load
- [x] Clean-room Panel.ts / sanitize.ts / i18n.ts written from observed interface (see headers)

## 5. API proxies (moved; _relay.js clean-room)

- [ ] (S) Each of 8 /api/ais-* functions returns relay data on the new Vercel project
- [x] Clean-room `_relay.js` (createRelayHandler) written from observed contract
- [x] (T) Fail-closed key gate + constant-time compare + no query-string keys — `api/_relay.test.mjs`

## 6. Ops / periphery

- [x] (S) Workflows written: `.github/workflows/ci.yml` (test + typecheck/build + e2e) and
      `freight-monitor.yml` (10-min Slack alerts). Still to port: sar-occupancy,
      assistant-eval, voice-drift.
- [x] `.env.example` written — all three deployables, every var, with what breaks if absent
- [ ] (S) Env populated in the new infra
- [ ] (S) Upstash: new ferry database; keys start fresh (voyage counts reset — accepted) or migrated
- [ ] (S) Postgres: point DATABASE_URL at the same Neon DB (zero-migration) or dump/restore
- [ ] (S) Domain, CSP connect-src in index.html, theme localStorage key decision

## Known gaps carried over (pre-existing, not regressions)

- `TRIPS_ENABLED` off by default — decide for new deploy
- ferry-monitor workflow name-coupled to old Railway host
