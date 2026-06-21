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

## Deploy as a Railway cron service

1. In the existing Railway project, **add a new service** from the same repo.
2. Start command: `node agent/monitor.mjs`  (no build/deps needed — pure Node +
   the shared port JSON).
3. Set it to run on a **cron schedule**, e.g. `*/10 * * * *`.
4. Set env vars: `RELAY_URL`, `RELAY_SHARED_SECRET`, `SLACK_WEBHOOK_URL`,
   `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`.

The agent is deploy-neutral to the web/relay: it lives in `agent/`, which is
outside the relay's watch paths and the Vercel build.
