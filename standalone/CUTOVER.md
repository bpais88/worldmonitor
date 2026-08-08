# Cutover runbook — Seaosea

Taking `standalone/` from a staging directory inside the worldmonitor fork to a live, independent
product. Written to be executed in order; each step says how you know it worked, and what to do if
it didn't. Nothing here is irreversible until step 7.

Assumes: `PARITY_MANIFEST.md` rows marked (T) are green (`npm test`), and two decisions already
taken (2026-08-08): git history is not preserved, and **nothing existing is rebuilt** — the same
Postgres, the same Upstash, and the same Railway services carry over. This runbook is written for
that path: it re-points infrastructure rather than provisioning it.

---

## 0. Before you start

**Nothing is provisioned. Nothing is migrated. No data moves.** The existing Railway services keep
their environment variables, their domains and their database connection; only the repository they
deploy from changes. Postgres and Upstash are untouched throughout.

**The relay keeps its current domain** (decided 2026-08-08). That is the largest simplification in
this runbook: `RELAY_URL` never changes, so Marco, the edge proxies and any external caller need no
update at all. The cutover becomes "move the domain between two Railway services", not "re-point
every client".

Have ready:
- Access to the existing Railway project (to change each service's source repo, and to move the
  custom domain between services at step 7).

> **The CSP does not need touching.** In production the browser only ever calls `/api/ais-*` on its
> own origin, which `connect-src 'self'` already allows; every direct-to-relay path in the frontend
> is gated on `hostname === 'localhost'` and is a dev-only fallback. The relay URL is used
> server-side by the edge proxies and by Marco, never by the browser.

---

## 1. Cut the repository

```bash
cp -r standalone /path/to/seaosea
cd /path/to/seaosea
git init && git add -A && git commit -m "Initial commit: Seaosea, extracted from the worldmonitor fork"
```

**Check:** `npm ci && npm test` → 311 relay + 155 assistant + 5 api, all green.
`npm run typecheck` → 0 errors. `npm run build` → succeeds.

If anything fails here it is a path problem, not a logic problem — every one of those suites passed
in staging.

---

## 2. Database — nothing to do

You are keeping the existing Postgres. The schema is already there, the history stays, no
migrations run. Skip to step 3.

> **One cleanup, unrelated to this migration — DECIDED: purge (2026-08-08).** The per-port radii
> shipped on 2026-08-01, so the rolling 8-week baseline window still holds ~7 weeks of snapshots
> taken under the OLD geometry for twelve ports (rotterdam, amsterdam, liverpool, southampton,
> savona, vado_ligure, venezia, porto_marghera, london_gateway, tilbury, immingham, hull). Until
> they age out, `congestionRel` blends two geometries: low for the shrunk ports, high for the
> widened ones — including Rotterdam, and it is the signal both freight tools are told to LEAD with.
>
> **Correction to an earlier note in this file: recovery is ~3 WEEKS, not 3 days.** `BASELINE_MIN_DAYS = 3`
> counts distinct local days *within a (port, dow, hour) bucket*, and a dow x hour bucket recurs once
> a WEEK — so three observed days means three successive weeks. The `n` column counts weeks, whatever
> it is named. The real trade is therefore:
>
> | | Effect on the 12 ports |
> |---|---|
> | **Purge** | `congestionRel: null` — honestly "unknown" — for ~3 weeks |
> | **Do nothing** | Confidently wrong numbers until ~2026-09-26 (~7 weeks) |
>
> Purge wins because unknown degrades safely and a wrong number does not — the same principle as the
> coverage fix this whole branch started from. Do it BEFORE cutover so the rebuild is already under
> way and is not confused with migration effects.
>
> ```bash
> node --env-file-if-exists=.env scripts/purge-radius-history.cjs            # dry run (default)
> node --env-file-if-exists=.env scripts/purge-radius-history.cjs --apply    # execute
> ```
>
> Dry run is the default and prints exactly what `--apply` would delete; the deletes run as one
> transaction and `port_events`/`trips`/`trip_points` are guarded against writes at runtime.
> **Restart the relay afterwards** — `congestionRel` is served from an in-memory baseline map
> refreshed on a 24h timer, so without a restart the old geometry's labels stay live for up to a
> day, which is the exact wrong-but-confident answer the purge exists to remove. `--apply` prints
> the redeploy command and a verification query.

---

## 3. Relay — a temporary second service, NOT a re-point yet

Do **not** re-point the existing relay service yet. Step 5 compares old against new, and you cannot
compare against something you have replaced.

Create a second Railway service in the same project, from `bpais88/seaosea`. Copy the existing
relay service's environment variables verbatim, then add:

```
RELAY_READ_ONLY=1
```

**This flag is why the parity run is safe.** Two relays against one database would double-write
port snapshots, duplicate geofence enter/exit events, and race the unique-open-trip constraint —
damaging the very history you are keeping. In read-only mode the new relay reads Postgres normally,
serves every endpoint, and performs no write of any kind: no snapshots, no events, no trips, no
baseline recompute, no voyage counters. `/health` reports `readOnly: true`, and the boot line says
`db=READ-ONLY`, so a relay can never be in this mode without it being obvious.

The service's start command comes from the repo's `railway.json` (`node scripts/relay.cjs`), so it
switches automatically. `RELAY_SHARED_SECRET` is required — the relay refuses to boot without it,
deliberately, so a missing variable can never publish the fleet.

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

## 4. Upstash — nothing to do

Keeping the existing instance. Voyage counters carry over, so `/ais/voyages/daily` keeps its
history.

The trade-off you are accepting: that instance still holds worldmonitor's keys (`relay:oref:*`,
`market:*`) alongside this product's (`relay:voyages:*`). The split is real in code but not in the
key space. Nothing breaks — the namespaces never collide — but if you later want a clean separation,
point the relay at a fresh instance and accept that per-day voyage counts restart. Nothing else in
Redis is durable.

---

## 5. Parity — the gate

Both relays are now live: the existing one writing as usual, the new one read-only beside it.

```bash
npm run parity -- --old https://<fork-relay> --new https://<new-relay> \
  --old-key "$OLD_SECRET" --new-key "$NEW_SECRET" --json parity.json
```

**Pass = exit 0.** Any `DIFF` line is real drift: either fix it, or add it to `ACCEPTED` in
`scripts/parity-diff.cjs` *with a written reason*. Never silence a diff without one.

This is the step that matters most. The local run (fork relay vs this one, both keyless) proved
shape and headers. Only this run proves behaviour with live AIS and real Postgres — the two things
the sandbox could never exercise.

Two caveats specific to running it read-only, so a difference here is not misread as a bug:
- `/health` will differ on `readOnly` and on write-counter fields (`lastWriteAt`, `snapshotRows`
  climbing on the old relay only). Expected.
- Trips are off in read-only mode, so `/health.trips.enabled` is false on the new side. Compare
  trips behaviour after the cutover instead, once the new relay is the one writing.

---

## 6. Web + Marco

**Web (Vercel):** this one genuinely is new — the existing project serves the worldmonitor
dashboard and would keep doing so. Create a project from `bpais88/seaosea`, root = repo root. Set
`RELAY_URL`, `RELAY_SHARED_SECRET`, and `API_VALID_KEYS` (**required** where routes set
`requireApiKey` — an empty list denies with 503, deliberately). No CSP change needed: the browser
talks only to `/api/*` on its own origin.

**Check:** the deployed page renders the board, the Ports view lists ports, and vessels appear once
AIS is flowing. `npm run test:e2e` locally covers the empty-state path; this is the populated one.

**Marco (Railway):** re-point the existing assistant service's source repo to `bpais88/seaosea`.
Its environment carries over untouched — and since the relay keeps its domain, `RELAY_URL` is
already correct. Because webhook URLs belong to the service rather than the repo, **no channel
needs re-registering**: Slack, Teams, Telegram and WhatsApp keep working across the switch.

> `BOARD_URL` (the "live board" link in the corridor report footer) is the one URL that does change,
> because the web app is a new Vercel project. Set it once that project has its domain; leaving it
> unset omits the line rather than printing a stale one.

**Check per channel** — a live message on each platform you actually run. Then confirm the ops
report renders: it reads `/health.trips` and `/health.portHistory`, and those blocks exist
precisely because the parity harness caught them missing.

---

## 7. Switch over

Only now, and only after step 5 passed:

1. Stop the OLD relay service (the one deploying from `worldmonitor`). One writer at a time.
2. Remove `RELAY_READ_ONLY` from the new service and redeploy. It is now the writer.
3. Move the custom domain from the old service to the new one. **No client changes anywhere** —
   Marco, the edge proxies and any external caller keep the URL they already have. This is the
   whole payoff of keeping the domain.
4. Watch `/health` for one full day: `connected`, `marinesia.tileAgesSec`, `portHistory.lastWriteOk`,
   and the freight-monitor Slack alerts.
5. Only then: delete the ferry code from the worldmonitor fork, or archive the fork entirely.

**Rollback, at any point:** move the domain back, re-add `RELAY_READ_ONLY=1` to the new service and
restart the old one. Both read the same Postgres, so no data is stranded and nothing needs
restoring — that is the whole reason for keeping one database. Because the domain is the only thing
that moves, rollback is a single Railway action, not a redeploy of every consumer.

---

## 8. Trips — arm a week after cutover, not during it

Decided 2026-08-08: **do not change trips behaviour at the same moment you change relays.** The
lifecycle is ported and covered by 11 wiring tests, but it has never run against real Postgres under
real traffic — it is the least battle-tested code in the repo. Changing two things at once means a
problem in either is hard to attribute to either.

During steps 3-6 this is automatic: the new relay is read-only, so trips are off there whatever the
env says, while the old relay keeps writing exactly as it does today. **No gap in trip history
during the parity window.** The choice only arrives at step 7, when the new relay becomes the writer.

**First, check what production actually does today** (this is still unverified):

```bash
curl -s https://<relay>/health | jq '.trips.enabled'
```

**If it returns `false`** — nothing to do at cutover. Leave `TRIPS_ENABLED` unset, run for a week,
then follow "arming" below.

**If it returns `true`** — you have live trip history worth protecting, and disabling it would open
a gap in that history for the sake of caution. Prefer to keep it on through the cutover, and treat
the first 24 hours as the soak: the watch list below is the same either way. Only force it off if
the relay shows any instability in step 7's first hours.

**Arming, whenever you do it:** set `TRIPS_ENABLED=1` (it also needs `DATABASE_URL`, or it stays off
regardless and logs why). Then watch `/health.trips` for a day:

- `degraded: true` — the pipeline is unhappy. The three causes are `lastTripWriteOk: false`,
  `tripPointsBuffered` at the high-water mark (4000), or an open trip past its cap awaiting the
  daily sweep. The third is benign; the first two are not.
- `tripPointsDropped > 0` — the buffer overflowed and breadcrumbs were lost. Should stay at 0.
- `oldestOpenTripAgeMin` climbing past `maxOpenAgeMin` (7200) — the direct open-trip-leak signal.
- `tripsArrived` vs `tripsAbandoned` — a healthy ratio means the geofence CLOSE side is firing. All
  abandons and no arrivals would mean arrivals are not being detected.

`assistant/ops-report.mjs` already renders every one of these into the scheduled Slack report, so
the watching is mostly done for you.

**Backing out:** unset `TRIPS_ENABLED` and redeploy. Writes stop immediately; rows already written
stay valid, and `resumeTrips()` picks the open ones back up whenever you re-arm.

---

## Known-open, deliberately

These are documented gaps, not oversights — decide each on its own merits:

- **Congestion thresholds are uncalibrated.** `busyAt: 4` / `congestedAt: 8` fleet-wide, from when
  every port was Italian. The per-port override mechanism exists; the numbers need observed
  at-berth distributions from `port_baselines`. Until then, `congestionRel` is the trustworthy
  signal and both freight tools lead with it.
- **31 of 43 ports use the default 8 km radius.** Twelve were set from measurable evidence; the
  rest need port knowledge. Note `port_events` and `trips` keep a documented discontinuity at the
  2026-08-01 geometry change — they are append-only with no recompute path, so deleting them would
  be pure loss rather than a refresh (49% of port_events, 42% of arrived trips at time of writing).
- **Antwerp, Hamburg, Le Havre, Bremerhaven, Gdańsk and Piraeus are not covered** — a product gap
  in something called "European freight". Adding a country is now ports + one `COUNTRY_SOURCES`
  entry; tiles, timezones and parity gates follow automatically. Cost: each country lengthens the
  fallback sweep.
- **Only Italy has an official strike registry.** Everyone else gets hedged news matches.
- **`TRIPS_ENABLED`** — decided: arm it a week after cutover, not during (see step 8).
