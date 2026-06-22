# Monitoring Agent — Build Plan ("the watch officer")

Status: **build plan, not implemented.** Concrete plan for the flagship agent
(shape #1 in `AGENTIC_ROADMAP.md`), grounded in the deployed detect→explain
pipeline.

## Goal

A scheduled agent that watches the live ferry fleet and **tells you what
matters** — not a dashboard you have to check. Output:

- **Real-time pings** for significant *new* incidents:
  *"⚠️ 3 ferries to Sardinia are delayed — official orange coastal warning in
  effect (Meteoalarm). Systemic, not a strike. Worst: GNV Azzurra, +1h10m."*
- **Periodic digest** (e.g. 08:00): *"Bay of Naples normal. 2 ongoing delays in
  Sicily (weather). Nothing systemic."*

The value the agent adds over the raw pipeline: **triage** (is this worth a
ping?), **synthesis** (group 3 related delays into one human sentence),
**reasoning over the reason-mix** (systemic vs isolated), and **delivery**.

## Architecture

```
 ┌── scheduler (cron, every ~10 min) ──┐
 │                                      ▼
 │   1. GATHER (deterministic)   GET relay /ais/vessels  → flagged ferries + reasons
 │   2. DEDUP/GATE (deterministic)  vs Upstash memory + severity thresholds
 │   3. REASON+WRITE (LLM)       Claude (Agent SDK) → which to alert, grouped brief
 │   4. DELIVER (deterministic)  send to Telegram/email
 │   5. REMEMBER (deterministic) write episodes to Upstash
 └──────────────────────────────────────┘
```

Runs as a **standalone Node app** (own dir, e.g. `agent/`), triggered by a
scheduler. It reaches the existing relay endpoint (with `RELAY_SHARED_SECRET`)
and Upstash — **no relay changes required** (the relay already returns
`delay.reasons` in `/ais/vessels`).

### Hybrid, not free-roaming (deliberate)

The detect+explain work is already deterministic, so the agent is a **bounded**
structured agent: deterministic gather → **one LLM reasoning/synthesis step** →
deterministic deliver. This is cheaper and more predictable than a fully
autonomous tool-calling loop for a recurring monitor. (Free-roaming tool use is
better saved for the *investigator* agent, shape #3, where exploration pays off.)

## The run loop (per tick)

1. **Gather** — `GET /ais/vessels?bbox=…&types=passenger,hsc`; keep vessels with
   a `delay` (slipping/stalled) + their `reasons`.
2. **Dedup & gate** (pure, tested):
   - Build an **episode key** per vessel: `mmsi + delay-onset bucket`.
   - Drop episodes already alerted (in memory) unless **escalated** (new reason
     kind, higher severity) or **resolved**.
   - Severity gate: real-time ping only above a threshold (e.g. red/orange
     Meteoalarm, systemic cluster, stalled, or ETA growth > N min); everything
     else flows to the digest.
   - Anti-spam: max pings/hour, quiet hours.
3. **Reason + write** (LLM, one call): give Claude the gated incidents + which
   were already alerted; it groups related ones, decides final worthiness, and
   writes the brief. Structured output (JSON schema): `{ pings: [...], digest }`.
4. **Deliver** — send pings (and the digest on its schedule) to the channel.
5. **Remember** — upsert episodes (firstAlerted, lastSeverity, reasonKinds) +
   prune resolved/stale.

## Claude Agent SDK shape

- **Model**: start with **Haiku 4.5** — input is small/bounded (a handful of
  flagged ferries) and the task is triage+phrasing; cheap + fast for a 10-min
  cadence. Upgrade specific steps to **Sonnet 4.6** if synthesis quality needs
  it. (Opus is overkill here.)
- **Tools** (if we let it pull detail): `get_delayed_ferries`, `get_recent_alerts`,
  `get_vessel_detail(mmsi)`. **Action** is deterministic (we send), or expose
  `send_alert`/`record_alert` as tools if we want the agent to decide delivery.
- **System prompt**: "maritime watch officer for Italian ferries… terse,
  factual, no hype; group related delays; never repeat an already-alerted
  ongoing incident; distinguish systemic (weather/strike) from isolated;
  escalate only on new/worse." 
- **Structured output** keeps delivery deterministic + testable.

## Prerequisites (the missing data sources)

1. **Outbound channel** — *required.* Recommend **Telegram bot** for v1: free,
   instant mobile push, one bot token + chat id. (Alts: email via Resend; Slack
   webhook.)
2. **Agent memory** — *required.* Reuse the **Upstash** wiring (already in the
   relay) with a new key namespace `agent:alerts:*` for episodes + dedup.
3. **`ANTHROPIC_API_KEY`** — *new secret* (first time we need one). Lives only in
   the agent's scheduler env; set it there directly (never in chat).

## Scheduler options

- **Railway cron service** — same platform, env vars handy, can reach the relay;
  keeps it in our infra. **Recommended.**
- **GitHub Actions cron** — free, dead-simple, secrets in GH; ~5-min granularity,
  cold start. Good for a purely personal tool.
- **Vercel Cron** — easy but serverless time limits make a multi-step agent
  awkward; workable for the lightweight version.

## Build phases (each testable, shippable)

- **Phase 0 — plumbing**: Telegram bot + Upstash `agent:*` keys + the standalone
  app skeleton + scheduler. Prove a hand-written message reaches your phone.
- **Phase 1 — deterministic monitor (no LLM)**: gather → dedup/gate → send raw
  templated alerts → remember. Validates the whole loop end-to-end; pure dedup/
  gate logic unit-tested (TDD). Already useful.
- **Phase 2 — LLM synthesis**: add the Claude reasoning/synthesis step (grouping,
  phrasing, systemic-vs-isolated judgment). Tested with fixtures (input →
  expected structured decision; API mocked) + a `--dry-run` mode (log, don't send).
- **Phase 3 — polish**: morning digest, escalation/resolution alerts, quiet
  hours, per-region preferences, rate-limit tuning.

## File layout (proposed)

```
agent/
  monitor.mjs            # entrypoint (one tick): gather→gate→reason→deliver→remember
  lib/gather.mjs         # relay fetch
  lib/episodes.mjs       # pure: episode keys, dedup, severity gate  (unit-tested)
  lib/memory.mjs         # Upstash read/write (agent:alerts:*)
  lib/synthesize.mjs     # Claude Agent SDK call + structured output
  lib/deliver.mjs        # Telegram/email
  monitor.test.mjs       # pure-logic tests
  railway.json|workflow  # scheduler config
```

## Cost

One bounded LLM call per tick (input = a few flagged ferries). On Haiku, every
~10 min, this is negligible. The deterministic gate keeps the LLM from running
on quiet ticks (skip the call when nothing passes the gate).

## Testability

- **Pure** (TDD): episode keying, dedup-vs-memory, severity gate, escalation/
  resolution detection.
- **Synthesis**: fixture inputs → assert the structured decision; mock the API.
- **End-to-end**: `--dry-run` logs the would-send alerts against live relay data.

## Open decisions (before building)

1. **Channel**: Telegram (recommended) / email / Slack?
2. **Scheduler**: Railway cron (recommended) / GitHub Actions / Vercel Cron?
3. **Cadence + philosophy**: how often; real-time-ping threshold; digest time;
   quiet hours.
4. **Personal vs product**: single chat id now, or multi-user later (affects
   memory keying + auth).
5. **Autonomy**: bounded structured agent (recommended) vs free tool-loop.
