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

## 2. Relay HTTP service — THE ONE REWRITE (pending)

The old `ais-relay.cjs` entry is upstream-licensed; a clean entry must be written.
Closed only by characterization tests written against the OLD relay first, then a
side-by-side parity diff (P) on:

- [ ] (P) GET /ais/ports (congestion + congestionRel + coverageOk + uncoveredPorts)
- [ ] (P) GET /ais/vessels (+ operator/type/freight filters, limit)
- [ ] (P) GET /ais/geofences · /ais/port-history · /ais/port-series · /ais/port-profile
- [ ] (P) GET /ais/trip · /ais/vessel-profile · /ais/voyages/daily · /ais/disruptions
- [ ] (P) GET /health · /metrics (shape, not values)
- [ ] (P) auth (x-relay-key 401), CORS, compression, rate limiting
- [ ] (S) Background jobs wired in the new entry: aisstream ingest, marinesia sweep,
      geofence tick, ferry delays, trips, baselines refresh, disruptions refresh,
      meteoalarm refresh, port context, vessel sync
- [ ] (S) NOT ported (upstream tenants, deliberately absent): /oref/*, /opensky*, /rss*,
      /worldbank, /polymarket, /ucdp-events, /notam, /yahoo-chart, /youtube-live,
      /telegram channel feed, market-quote seeder

## 3. Marco (moved wholesale)

- [x] (T) Agent loop, guardrails, grounding, coverage prose gates, watches, ops report,
      send seam, per-channel verify (Slack/Teams/Telegram-bot/WhatsApp/voice) — **155/155** here
- [ ] (S) Live channel smoke per platform after deploy (webhook URLs re-pointed)
- [ ] (S) assistant/railway.json deployed as its own service in new infra

## 4. Frontend (moved + 3 clean-room rewrites)

- [x] (S) Builds + typechecks (0 errors) with clean-room Panel/sanitize/i18n and fresh vite config
- [ ] (S) Visual smoke: board renders, map tiles, region tabs, vessel popup, replay controls
- [ ] (S) NEW Playwright smoke spec (the app has never had e2e — add at cutover)
- [x] Clean-room Panel.ts / sanitize.ts / i18n.ts written from observed interface (see headers)

## 5. API proxies (moved; _relay.js clean-room)

- [ ] (S) Each of 8 /api/ais-* functions returns relay data on the new Vercel project
- [x] Clean-room `_relay.js` (createRelayHandler) written from observed contract

## 6. Ops / periphery

- [ ] (S) Workflows re-created: ferry-monitor (RELAY_URL secret → new host), sar-occupancy,
      assistant-tests, assistant-eval, voice-drift + fresh lint/typecheck
- [ ] (S) Env manifest populated in new infra (see findings doc iteration 4 list)
- [ ] (S) Upstash: new ferry database; keys start fresh (voyage counts reset — accepted) or migrated
- [ ] (S) Postgres: point DATABASE_URL at the same Neon DB (zero-migration) or dump/restore
- [ ] (S) Domain, CSP connect-src in index.html, theme localStorage key decision

## Known gaps carried over (pre-existing, not regressions)

- No e2e coverage (row 4.3)
- `TRIPS_ENABLED` off by default — decide for new deploy
- ferry-monitor workflow name-coupled to old Railway host
