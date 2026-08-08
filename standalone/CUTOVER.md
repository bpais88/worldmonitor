# Cutover runbook

Taking `standalone/` from a staging directory inside the worldmonitor fork to a live, independent
product. Written to be executed in order; each step says how you know it worked, and what to do if
it didn't. Nothing here is irreversible until step 7.

Assumes: `PARITY_MANIFEST.md` rows marked (T) are green (`npm test`), and you accept that git
history is not being preserved (decided 2026-08-08).

---

## 0. Before you start

Have ready:
- The AIS keys (`AISSTREAM_API_KEY`, `MARINESIA_API_KEY`) — the ones the fork's relay uses today.
- The Postgres connection string (`DATABASE_URL`).
- A new Upstash Redis database (see step 4 for why not the existing one).
- Anthropic + whichever channel credentials Marco actually uses in production.

Decide two things now, because they change later steps:
- **Postgres: share or copy?** Pointing the new relay at the *same* Neon database is zero-migration
  and keeps all trip/baseline history. Running both relays against it simultaneously is safe for
  reads but means both write snapshots — acceptable briefly, but keep the overlap short.
- **Domain.** The web app's CSP `connect-src` in `index.html` currently allows `localhost:3004`
  only, plus the Vercel proxy path. Production needs the real relay origin added.

---

## 1. Cut the repository

```bash
cp -r standalone /path/to/freight-monitor
cd /path/to/freight-monitor
git init && git add -A && git commit -m "Initial commit: freight monitor extracted from the worldmonitor fork"
```

**Check:** `npm ci && npm test` → 311 relay + 155 assistant + 5 api, all green.
`npm run typecheck` → 0 errors. `npm run build` → succeeds.

If anything fails here it is a path problem, not a logic problem — every one of those suites passed
in staging.

---

## 2. Database

Run the migrations in order against the target Postgres:

```bash
for f in scripts/migrations/0*.sql; do psql "$DATABASE_URL" -f "$f"; done
```

**Check:** `psql "$DATABASE_URL" -c '\dt'` lists `ports`, `port_snapshots`, `port_events`,
`port_baselines`, `trips`, `trip_points`, `disruption_log`.

**If you are sharing the existing database, skip this** — the tables are already there and the
migrations are idempotent but there is no reason to run them.

> **Do this too:** purge `port_snapshots` for the twelve ports whose radius changed
> (rotterdam, amsterdam, liverpool, southampton, savona, vado_ligure, venezia, porto_marghera,
> london_gateway, tilbury, immingham, hull). Their baselines otherwise blend old and new geometry
> for up to 8 weeks. `scripts/purge-radius-history.cjs` does exactly this.

---

## 3. Relay service

Deploy `scripts/relay.cjs` (Railway, or anything that runs Node 22).

Environment: copy `.env.example` and fill it. `RELAY_SHARED_SECRET` is **required** — the relay
refuses to boot without it, deliberately, so a missing variable can never publish the fleet.

**Check, in this order:**
1. `curl https://<relay>/health` → 200, `status: "ok"`.
2. `curl -H "x-relay-key: $SECRET" https://<relay>/ais/ports | jq '.ports | length'` → 43.
3. Wait 2 minutes, then re-check `/health`:
   - `connected: true` → aisstream is streaming.
   - `marinesia.tileAgesSec` → mostly non-null and climbing/resetting; all-null means the fallback
     never polled (check `marinesia.lastError`).
   - `db: true`.
4. `curl -H "x-relay-key: $SECRET" https://<relay>/ais/ports | jq '[.ports[] | select(.coverageOk)] | length'`
   → should be 43 once a feed is live. If it stays 0, coverage is broken and every port will be
   reported as "not currently visible" — correct behaviour, but the wrong answer.

**Watch for the one thing that has never been tested:** per-tile vessel counts against Marinesia's
2000-per-request cap. The four non-Italian regions were sized geometrically, not measured. The relay
logs `marinesia tile N at the 2000 cap — likely truncated` when it happens. If a tile pins there,
subdivide that region in `scripts/marinesia.cjs` (raise its grid) and redeploy.

---

## 4. Upstash

Create a **new** database rather than sharing. The fork's instance mixes this product's keys
(`relay:voyages:*`) with worldmonitor's (`relay:oref:*`, `market:*`); a clean instance means the
split is real rather than a naming convention.

Cost of a fresh instance: per-day voyage counters restart, so `/ais/voyages/daily` shows zeros for
prior days. Nothing else carries over in Redis.

**Check:** `curl -H "x-relay-key: $SECRET" https://<relay>/ais/voyages/daily?days=3` → 200 with
three dated rows.

---

## 5. Parity — the gate

With the new relay live and the fork's relay still running:

```bash
npm run parity -- --old https://<fork-relay> --new https://<new-relay> \
  --old-key "$OLD_SECRET" --new-key "$NEW_SECRET" --json parity.json
```

**Pass = exit 0.** Any `DIFF` line is real drift: either fix it, or add it to `ACCEPTED` in
`scripts/parity-diff.cjs` *with a written reason*. Never silence a diff without one.

This is the step that matters most. The local run (fork relay vs this one, both keyless) proved
shape and headers. Only this run proves behaviour with live AIS and real Postgres — the two things
the sandbox could never exercise.

---

## 6. Web + Marco

**Web (Vercel):** new project, root = repo root. Set `RELAY_URL`, `RELAY_SHARED_SECRET`,
`API_VALID_KEYS` (**required** where routes set `requireApiKey` — an empty list denies with 503,
deliberately). Add the relay origin to `connect-src` in `index.html`.

**Check:** the deployed page renders the board, the Ports view lists ports, and vessels appear once
AIS is flowing. `npm run test:e2e` locally covers the empty-state path; this is the populated one.

**Marco (Railway, `assistant/railway.json`):** deploy separately, point `RELAY_URL` at the new
relay, re-point each channel's webhook URL.

**Check per channel** — a live message on each platform you actually run. Then confirm the ops
report renders: it reads `/health.trips` and `/health.portHistory`, and those blocks exist
precisely because the parity harness caught them missing.

---

## 7. Switch over

Only now, and only after step 5 passed:

1. Point DNS / clients at the new relay.
2. Watch `/health` and the freight-monitor Slack alerts for one full day.
3. Turn off the fork's relay service.
4. Delete the ferry code from the worldmonitor fork (or archive the fork entirely — nothing in it
   is needed by this product any more).

**Rollback at any point before (3):** re-point clients at the fork's relay. Both read the same
Postgres if you shared it, so no data is stranded.

---

## Known-open, deliberately

These are documented gaps, not oversights — decide each on its own merits:

- **Congestion thresholds are uncalibrated.** `busyAt: 4` / `congestedAt: 8` fleet-wide, from when
  every port was Italian. The per-port override mechanism exists; the numbers need observed
  at-berth distributions from `port_baselines`. Until then, `congestionRel` is the trustworthy
  signal and both freight tools lead with it.
- **31 of 43 ports use the default 8 km radius.** Twelve were set from measurable evidence; the
  rest need port knowledge.
- **Antwerp, Hamburg, Le Havre, Bremerhaven, Gdańsk and Piraeus are not covered** — a product gap
  in something called "European freight". Adding a country is now ports + one `COUNTRY_SOURCES`
  entry; tiles, timezones and parity gates follow automatically. Cost: each country lengthens the
  fallback sweep.
- **Only Italy has an official strike registry.** Everyone else gets hedged news matches.
- **`TRIPS_ENABLED` is off by default.** The lifecycle is ported and tested; arming it is a
  decision, and it needs `DATABASE_URL` or it stays off regardless.
