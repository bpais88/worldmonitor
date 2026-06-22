# Ferry Monitoring Agent ("watch officer")

Phase 1 (deterministic) of the monitoring agent — see
`docs/MONITORING_AGENT_BUILD_PLAN.md`. One tick:

```
gather flagged ferries (relay) → classify vs memory (dedup / severity gate /
escalation / resolution) → deliver Slack pings + resolutions → persist memory
```

No LLM yet (that's Phase 2). Pure logic is unit-tested:
```
node --test agent/lib/*.test.mjs
```

## Run locally (dry-run — logs instead of posting)

```bash
RELAY_URL=https://<relay-host> \
RELAY_SHARED_SECRET=<secret> \
node agent/monitor.mjs --dry-run
```

## Environment

| Var | Required | Purpose |
|-----|----------|---------|
| `RELAY_URL` | yes | Relay base URL (e.g. the Railway relay) |
| `RELAY_SHARED_SECRET` | yes | Auth for the relay `/ais/vessels` endpoint |
| `SLACK_WEBHOOK_URL` | to send | Slack incoming webhook; absent ⇒ dry-run |
| `UPSTASH_REDIS_REST_URL` / `_TOKEN` | for dedup | Cross-run memory; absent ⇒ in-memory (no cross-run dedup) |
| `FERRY_BBOX` | no | Override the Italy bbox |
| `MONITOR_MAX_PINGS` | no | Max individual pings per tick (default 6; rest summarised) |

**Cron caveat:** each cron run is a fresh process, so cross-run dedup *requires*
Upstash. Without it the agent re-pings ongoing delays every tick.

## Deploy — GitHub Actions cron (live)

The scheduled run is wired in `.github/workflows/ferry-monitor.yml` (every 10
min + a manual "Run workflow" button). To go live, add in the GitHub repo
(Settings → Secrets and variables → Actions):

- **Variable** `RELAY_URL` = the Railway relay base URL.
- **Secrets**: `RELAY_SHARED_SECRET`, `SLACK_WEBHOOK_URL`,
  `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`.

Until `SLACK_WEBHOOK_URL` is set the agent runs in dry-run (logs only, visible in
the Actions run logs). Use the "Run workflow" button with *dry_run* checked to
test safely.

**Cron caveat:** each run is a fresh process, so cross-run dedup *requires*
Upstash. Without it the agent re-pings ongoing delays every tick.

### Alternative: Railway cron service

`agent/railway.json` (cronSchedule `*/10`, start `node agent/monitor.mjs`) is
provided if you prefer Railway; create a new service in the project, set its
Config File Path to `agent/railway.json` (dashboard), and add the same env vars.

The agent is deploy-neutral to the web/relay: it lives in `agent/`, outside the
relay's watch paths and the Vercel build.
