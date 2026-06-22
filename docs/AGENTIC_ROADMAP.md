# Agentic Roadmap — Ferry / Maritime Intelligence

Status: **planning doc.** Captures agent shapes, framework fit, and the data
sources future agents will need. Nothing here is implemented yet. It builds on
the deployed **detect → explain** foundation.

## Where we are (the foundation, already built)

A deterministic real-time pipeline — *not* an agent yet, deliberately:

- **Ingest**: Railway relay off aisstream (auto-deploys from `main`).
- **Detect**: ETA-drift delay detection (Method B), per vessel.
- **Explain**: 6-source pluggable "why" engine — Meteoalarm (official), weather
  + fog, port congestion, cross-vessel correlation, news; operator-status spec'd
  (`OPERATOR_STATUS_EXPLAINER.md`).
- **Surface**: map + table + popups (web + mobile).
- ~134 tests, TDD, all green.

This is the **tooling layer** an agent stands on. The agentic part — *judgment,
synthesis, deciding what matters, acting* — is what's below.

## Agent shapes

### 1. Always-on monitoring agent ("the watch officer") — highest fit

Runs on a schedule (e.g. every 5–15 min). Calls detect+explain, decides what's
*worth surfacing* (dedupe, severity, novelty), and writes a natural-language
brief: *"3 Sardinia ferries delayed — official orange coastal warning in effect;
not a strike. Bay of Naples normal."* Pushes to a channel (Telegram/email/in-app).

- **Why it fits now**: sits directly on the deployed tools; the hard signal work
  is done. The agent adds judgment + phrasing + delivery.
- **Agentic value**: triage ("is this worth a ping?"), synthesis across sources,
  alert dedup/memory ("already told you about this vessel").
- **Effort**: medium. Needs a tool layer + a scheduler + an outbound channel + a
  small memory store (what's been alerted).

### 2. Conversational analyst ("ask the fleet") — lowest effort, great demo

Plain-language Q&A over live data: *"Which ferries to Sardinia are delayed and
why?" / "Show all Moby vessels at anchor."*

- **Why it fits**: data is structured; mostly tool definitions + a chat surface.
- **Agentic value**: turns the dataset into self-serve answers; no fixed UI.
- **Effort**: low–medium.

### 3. Incident investigator (branchy, deeper) — LangGraph-shaped

When a delay fires, a multi-step agent digs: pulls extra sources, cross-checks,
escalates, and produces a confidence-rated incident report. Branches, retries,
optional human-in-the-loop.

- **Why it fits**: the explain engine gives first-pass reasons; this goes deeper
  on the interesting ones.
- **Effort**: higher; only worth it once #1 exists and we want depth.

### 4. Freight/logistics product agent — ties to the portfolio

Shipment-aware layer for getfreightbox / a fleet product: *"Your container is on
MOBY X (now delayed 40 min, official weather warning) — ETA impact + reroute
options."* Maps real-time maritime tracking onto cargo/shipment context.

- **Why it fits**: highest commercial leverage; connects this capability to an
  existing product line.
- **Effort**: larger; needs shipment/booking data + product integration.

## Framework / runtime fit

- **Claude Agent SDK** — best for #1 and #2. It's the agent loop + tool-use
  (what Claude Code is built on); production-ready with defined tools. Pair with
  a cron/scheduled run for the monitoring agent. **Default choice for our shapes.**
- **LangGraph** (Python) — best for #3: stateful, branchy graphs with explicit
  control flow, retries, checkpoints, human-in-the-loop. Reach for it when the
  reasoning has real branches/loops, not a single tool-use loop.
- **pi.dev** — *unverified.* Categorize as a candidate agent runtime/hosting/eval
  platform; **do not adopt sight-unseen.** Action: run a `tech-scout` eval
  against Claude Agent SDK + LangGraph before committing. Don't bet on it blind.

Rule of thumb: **Claude Agent SDK for the loop + tools; LangGraph when control
flow gets branchy; evaluate pi.dev (and others) as runtime/hosting, not as the
reasoning engine.**

### Vercel Eve vs. our hand-built agent (decision on record)

Eve is Vercel's agent framework ("an agent is a directory" — markdown + TS tools

+ skills; multi-channel deploy incl. Slack/Discord/web/API/scheduled; durable
workflows, human-in-the-loop, subagents, evals, AI Gateway). Key reframe: **our
system is two layers, and Eve only competes with one.**

- **Engine** (detect + 6-source explain, on the relay) — the domain IP. *No
  framework provides this; it stays regardless.*
- **Plumbing** (cron → gather → classify → deliver → memory) — the commodity
  layer. This is the only part Eve replaces.

| | Ours (built, Phase 0/1) | Eve |
|---|---|---|
| Scheduled run / Slack / memory | ✅ (Railway cron, Upstash) | ✅ built-in |
| Multi-channel (Discord/web/API) | ❌ (Slack only) | ✅ |
| Incident classification (ferry-specific) | ✅ ours | ❌ you still write it |
| Durable exec / human-in-loop / subagents / evals | ❌ | ✅ |
| Lock-in | Railway + Upstash (portable) | Vercel runtime |
| Maintenance | ~150 lines | framework (v0/new) |

**Verdict:** for the *monitoring agent alone*, Eve adds little — ours already
does it and the hard part (classification + the why-engine) is ours either way.
**Eve earns its keep for the *next* agents** — the conversational analyst
(multi-channel web chat) and anything needing durability / human-in-the-loop /
eval-driven iteration.

**Decision:** ship the monitor on ours (done, no lock-in). Re-evaluate Eve (vs
Claude Agent SDK) via `tech-scout` when building the **conversational analyst**
or going multi-channel — checking GA status, Claude support via AI Gateway,
ability to call the external Railway relay, pricing, and lock-in.

## Data sources still needed (ranked by leverage for agents)

What would most increase agent capability, roughly highest-value first:

1. **Durable history / vessel-track store** — persist ETA snapshots + tracks
   (Upstash already wired for delay history; extend it). Unlocks **learned
   "normal duration"** (Method A without timetables), trend/anomaly detection,
   and "this vessel usually does X." *Foundational — most agent smarts need memory.*
2. **Operator schedules (timetables)** — true "late vs scheduled" (Method A) and
   "next departure" context. Data-ops heavy (seasonal), but high value.
3. **Operator status notices** — official cancellations (spec'd). Top-signal "why."
4. **Weather *forecast* (not just nowcast)** — Open-Meteo forecast enables
   *prediction*: "storm arriving in 3h → expect cancellations," not just reaction.
5. **Outbound notification channel** — Telegram/email/Slack/push. Without this an
   agent can detect but can't *reach* the user. Required for #1.
6. **Agent memory/state store** — what's been alerted (dedupe), open incidents,
   user preferences. Required for a non-spammy monitoring agent.
7. **Vessel registry (IMO → particulars)** — type, size, build, confirmed
   operator; richer identity than AIS alone.
8. **Tide / sea-depth** — shallow ports + draught (niche but real for some routes).
9. **Social / X feeds** — real-time passenger disruption reports (noisy; a late
   but human signal).
10. **Shipment / booking data** — required only for the freight agent (#4).

## Ideas already surfaced (reuse these)

- Monitoring agent emitting NL alerts (#1) — *original opportunity #1.*
- Conversational analyst (#2) — *original opportunity #2.*
- Multi-source "why" (#3) — **built** (deterministic core); investigator agent
  is the agentic extension.
- Tie into freight products (#4) — *original opportunity #4; portfolio fit.*
- Learned "normal duration" baseline (Method A via accumulation) — needs #1 data
  source above.
- Cross-vessel correlation, port congestion — **built** as explainers; also
  useful as agent tools.

## Recommended sequencing

1. **Data: durable history + notification channel** (#1, #5 above) — small,
   unlocks everything agentic.
2. **Monitoring agent (shape #1)** on Claude Agent SDK — the flagship; turns the
   pipeline into something that *tells you* things.
3. **Conversational analyst (shape #2)** — cheap, high demo value, reuses the
   same tools.
4. **Investigator (shape #3, LangGraph)** and/or **freight agent (#4)** — once
   the above prove out and direction is chosen.

## Open questions / decisions

- Which **channel** for alerts (Telegram is quick + free; email; in-app)?
- Personal tool vs product? (Drives freight-agent priority + auth/multi-user.)
- pi.dev: evaluate, or default to Claude Agent SDK + LangGraph?
- How much to invest in **timetables** (Method A) vs lean on learned baselines?
- Alert philosophy: digest cadence vs real-time pings; how aggressive.
