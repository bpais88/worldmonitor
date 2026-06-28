# Marco — Learnings & Reusable Patterns

A consolidated engineering reference for **Marco**, a multi-workspace Slack AI agent built on the `worldmonitor` Italian-port freight/maritime tracker. Scope tags are preserved throughout: `generalizable-any-agent`, `generalizable-slack`, and `worldmonitor-specific`.

---

## 1. Overview & Architecture at a Glance

Marco is a single, stateless Node `http` process (no Express/Bolt) that serves **every** Slack workspace from one binary. Customers self-install via "Add to Slack" (OAuth v2); each workspace's bot token is stored keyed by `team_id` and resolved per inbound event. The "brain" is an Anthropic tool-use loop (`assistant/agent.mjs`) that is fully platform- and domain-agnostic — capabilities are added by registering tool objects, never by editing the loop.

The system decomposes into three concentric layers:

- **Platform-neutral core** — `agent.mjs` (the agentic loop), `guardrails.mjs` (action policy), `watches.mjs`, `usage.mjs`, `store.mjs` (KV), `config.mjs` (env binding), and the domain tools under `assistant/tools/`. Keyed by an opaque `tenantId`; never branches on platform.
- **Slack adapter** — `assistant/slack/server.mjs` (the HTTP backbone), `verify.mjs`, `oauth.mjs`, `installations.mjs`, `pending.mjs`, `permissions.mjs`, `memory.mjs`, `onboarding.mjs`, `legal.mjs`, and `marco-app-manifest.json`.
- **Domain (worldmonitor) data plane** — `relay.mjs` (authenticated GET client to the AIS/ports backend), `tools/freight.mjs`, `tools/weather.mjs`, `tools/watches.mjs`, `tools/actions.mjs`, plus the shared freshness module (`scripts/freshness.cjs` / `src/services/logistics/freshness.ts`).

Key architectural principle (`MULTI_PLATFORM.md`): **one brain, thin per-platform adapters.** Only message *receive → run → send* is platform-specific; everything else is keyed by an opaque tenant id so a second platform (Teams) is roughly a day of adapter work rather than a rewrite. **Now realized — Marco runs on Microsoft Teams in production from the same core; see §14.**

The guardrail has **two consumers** that prove this decoupling: the Slack adapter (which force-proposes every action) and the CLI (`cli.mjs`), which exposes a graduated `blocked → --allow-actions (dry-run) → --execute` flag escalation over the *same* pure policy. The policy logic never knows which surface it's serving.

External dependencies: Slack (OAuth v2, Web API, Events API, Block Kit interactivity, app manifest), Anthropic (`@anthropic-ai/sdk`, model `claude-sonnet-4-6` via `ASSISTANT_MODEL` — the agent default; do not "upgrade" this string), Upstash Redis (REST, with in-memory fallback), Railway (multi-replica hosting), the internal relay (`RELAY_URL`), Marinesia/aisstream (live AIS feeds), and Open-Meteo (free marine/wind weather, no key).

---

## 2. Multi-Tenancy & OAuth Install ("Add to Slack")

The core of multi-tenancy: **key everything by `team_id`** and look up the bot token per inbound event rather than holding one global token.

**Install flow** (`assistant/slack/oauth.mjs`, routed in `server.mjs`):

- `authorizeUrl()` is a **pure** function that builds the OAuth v2 consent URL: `https://slack.com/oauth/v2/authorize` with `client_id`, `scope` (comma-joined), `redirect_uri`, `state`.
- `/slack/install` mints a one-time CSRF `state` (`newState()`) and redirects to the consent URL.
- `/slack/oauth/callback` rejects unless `consumeState(state)` succeeds, then `exchangeCode()` POSTs to `https://slack.com/api/oauth.v2.access` (x-www-form-urlencoded: `client_id`, `client_secret`, `code`, `redirect_uri`).
- `exchangeCode({...,fetchImpl=fetch})` is injectable for testing. It checks `j.ok`, throws on `j.error`, and **normalizes** the raw Slack response into a flat shape: `{teamId, teamName, botToken, botUserId, installedBy, installedAt}` so downstream code never touches raw Slack field names.
- On success: `saveInstallation()`, `addActionUser(teamId, installedBy)` (seed the allowlist with the installer), and DM the installer an onboarding intro via `apiFor(inst.botToken).dm`.

**`redirect_uri` derivation:** `SLACK_REDIRECT_URI` env if set, else `${proto}://${host}/slack/oauth/callback` from request headers, honoring `x-forwarded-proto` behind a proxy. It must match exactly across build-authorize-URL, token-exchange, and the value registered in the Slack app. `[generalizable-slack]`

**CSRF state** must survive across replicas — see §3. The `/install` and `/callback` halves can land on different Railway replicas.

**`CLIENT_ID` presence is the mode switch:**
- With `CLIENT_ID` → multi-tenant: landing page shows "Add to Slack"; action-users come from per-workspace `cfg.actionUsers`.
- Without `CLIENT_ID` → single-tenant/legacy: landing page returns JSON health; action-users come from env (`ENV_ACTION_USERS`). `[generalizable-slack]`

**Slack OAuth v2 facts (verified in `oauth.mjs`):** in `oauth.v2.access`, the **bot** token is `j.access_token` (an `xoxb-` token); `j.bot_user_id` is the bot's user id; `j.team.id`/`.name` is the workspace; `j.authed_user.id` is the human who installed (granted approval rights + DM'd onboarding). Slack returns `ok:false` + `error` even on HTTP 200 — always check `j.ok`.

---

## 3. Token Storage & Persistence

All persistence flows through a tiny KV abstraction (`assistant/store.mjs`):

- **`PERSISTENT = !!(URL && TOKEN)`** toggles between Upstash Redis REST (GET / SET EX / DEL / SADD / SREM / SMEMBERS via a single `redis(...cmd)` POST) and a process-local `Map`/`Set`.
- Same `kvGet/kvSet/kvDel/setAdd/setRem/setMembers` signatures both ways, so app code is storage-agnostic and runs locally with **zero config**. `[generalizable-any-agent]`

**Per-tenant install + config store** (`assistant/slack/installations.mjs`):

- `instKey(teamId) = slack:inst:<teamId>` holds the normalized installation.
- `cfgKey = slack:cfg:<teamId>` holds per-workspace config.
- `INDEX = 'slack:teams'` is a Redis SET of all team ids for listing/iteration.
- `save = kvSet(instKey) + setAdd(INDEX)`; `list = setMembers(INDEX)` then `kvGet` each; `remove = kvDel(inst) + kvDel(cfg) + setRem(INDEX)`.
- `getConfig()` **always merges over `DEFAULT_CONFIG`** so callers never null-check; new config keys get safe defaults for already-installed workspaces with no migration. `setConfig()` shallow-merges a patch. `addActionUser()` is a guarded, idempotent append.
- `DEFAULT_CONFIG = { ports, operators, actionUsers, onboarded }`. `[generalizable-slack]`

**Three persistence fallbacks / failure modes:**

1. **Legacy env-token fallback** — `botToken = inst?.botToken || SLACK_BOT_TOKEN`. Every token/authorized-user resolution is `inst?.X || ENV`. This is the migration ramp from single- to multi-tenant. `[generalizable-slack]`
2. **In-memory KV fallback** — for local dev only. **GOTCHA (high):** without Upstash creds in prod, a redeploy silently de-installs every workspace (install tokens, memory, watches all evaporate). Gate prod readiness on `PERSISTENT` / log loudly. For a distributable multi-tenant app, durable KV is **required**, not optional.
3. **Stale index entries** — `listInstallations` / `listWatches` can return dangling ids if a value key expires but the id stays in the SMEMBERS index. **Self-heal on read:** prune the index (`setRem(INDEX, id)`) when `kvGet` returns null. Set-index and value writes are not atomic in this KV. `[generalizable-any-agent]` (severity low)

---

## 4. Slack Platform Integration

### HTTP backbone (`assistant/slack/server.mjs`, ~427 lines)

**Why raw `node:http` instead of Express/Bolt:** Slack signature verification needs the **exact raw request body**; a framework's body parser mutates/re-serializes it and breaks the HMAC. Read the raw string once (`readBody`), verify **before** any `JSON.parse`/`URLSearchParams`, keep the dependency surface tiny.

**Route split (explicit trust boundary):**
- **Unsigned GET** — browser/health/OAuth/legal (`/`, `/health`, `/slack/install`, `/slack/oauth/callback`, `/privacy`, `/support`).
- **Signed POST** — Slack events (`/slack/events`) + interactions (`/slack/interactions`). `verified()` is called once after `readBody`, gating both handlers. `[generalizable-slack]`

**The minimal backbone** (the reusable skeleton): handle `url_verification` by echoing `{challenge}`; verify signature once; **200 immediately** then `void handleEvent(...)` / `void handleInteraction(...)` as detached promises.

### Signature verification (`assistant/slack/verify.mjs`) `[generalizable-slack]`

Self-contained `verifySlackSignature({signingSecret, signature, timestamp, body, now})`:
1. **Staleness check first** — reject if `x-slack-request-timestamp` is more than **5 minutes** from `now` (replay protection). The timestamp is part of the signed string so it can't be forged independently.
2. HMAC-SHA256 over `v0:<ts>:<body>`; the header is `x-slack-signature = 'v0=' + HMAC`.
3. **`crypto.timingSafeEqual`** with a length guard (it throws on length mismatch) wrapped in try/catch — avoids timing leaks from `===`.
4. Takes `now` as a param so it is unit-testable. **Copy verbatim into any Slack agent.**

### Events vs interactions — different encodings

- **Events:** POST raw JSON. Parse with `JSON.parse(body)`.
- **Interactions (block_actions):** POST `application/x-www-form-urlencoded` with a single `payload` field that is itself JSON. Parse with `JSON.parse(new URLSearchParams(body).get('payload'))`. Mixing these up produces silent failures. `[generalizable-slack]`

### The 3-second rule & dedupe

Slack retries any events/interactions endpoint that doesn't 200 within ~3s (with `X-Slack-Retry-Num`), and on its own schedule. **Ack first, process async.** Dedupe by `event_id` via the `seenEvents` Set + `alreadySeen()`, capped at 1000 entries (evicting oldest). **Caveat:** this dedupe is per-process — two replicas can still double-process; acceptable because handlers are mostly idempotent, but flag it on reuse. `[generalizable-any-agent]`

### Loop prevention

The bot sees its own posts and other bots' messages. Before replying, drop events where `ev.bot_id`, `ev.subtype`, or `ev.user === botUserId`, and gate to only `app_mention` and `im` (DM, `channel_type === 'im'`). Threading uses `threadTs = ev.thread_ts || ev.ts`.

### `team_id` resolution (defensive fallback chains)

`team_id` lives in different places across payload shapes:
- Events: `payload.team_id || ev.team || payload.team?.id || ''`
- Interactions: `payload.team?.id || payload.user?.team_id`
- **Background jobs have no payload** — the team must be stored on the work item (`watch.team`) at creation time.

The token lookup depends entirely on getting this right.

### Token-bound helper factory (`apiFor`)

`apiFor(botToken)` closes over the token and returns `{post, update, dm}` so call sites never pass tokens around and **can't accidentally use the wrong workspace's token**. Used both during the agent run and on button approval. `[generalizable-any-agent]`

### Manifest, scopes & events (`assistant/slack/marco-app-manifest.json`)

**Manifest-as-code** — one paste sets display info, `bot_user`, App Home, all bot scopes, OAuth redirect, every event subscription, and interactivity; reproducible and reviewable in git. `[generalizable-slack]`

**Minimal bot scopes** (least privilege — backs the "we don't read other channel messages" privacy claim):
- `app_mentions:read` — hear @mentions
- `chat:write` — reply + post alerts
- `im:history` — read DM thread
- `im:write` — **required** to open the onboarding DM (`conversations.open` → `chat.postMessage`)
- `users:read` + `team:read` — resolve user/workspace names

> Note: single-workspace `README` lists a leaner set (`im:read` instead of `im:write`/`users:read`/`team:read`). Adding a scope requires a **re-install** to take effect.

**Bot events** (`event_subscriptions.bot_events`): `app_mention`, `message.im`, `app_home_opened` (onboarding trigger — the key non-obvious one), `app_uninstalled` + `tokens_revoked` (cleanup triggers).

**Three request URLs** all point at the running service: `event_subscriptions.request_url` (`/slack/events`), `interactivity.request_url` (`/slack/interactions`), `oauth_config.redirect_urls` (`/slack/oauth/callback`).

**App Home config:** `home_tab_enabled` (makes `app_home_opened` fire) + `messages_tab_enabled` + `messages_tab_read_only_enabled:false` (writable so users can DM). `bot_user.always_online:true` for presence. `socket_mode_enabled:false`, `token_rotation_enabled:false`, `org_deploy_enabled:false` — an HTTP-events app with non-rotating, non-org tokens.

### Lifecycle / uninstall

`app_uninstalled` and `tokens_revoked` must be handled **without a token** (it may already be dead) — derive `teamId` from the payload and process **before** any token lookup (`server.mjs` ~159–166, returns early with the comment "No token needed — it may already be gone"). They trigger `removeInstallation(teamId)` + `cancelWatchesForTeam(team)` to honor the privacy policy.

### Slack rendering note (mrkdwn, not Markdown)

Slack renders mrkdwn: `*bold*` (single asterisks), `_italics_`, `'• '` bullets — **no** markdown tables or `##` headers. Steer the model explicitly in the system prompt (`SLACK_SYSTEM`). Every Web API call returns `{ok:false, error}` on failure (not an HTTP error) — always parse JSON and check `j.ok`; `unfurl_links:false` suppresses link previews.

---

## 5. Permissions & Action-Approval Guardrails

The safety model lets Marco answer read-only questions for **anyone** while ensuring any side-effecting action is only ever **proposed** by the LLM and **executed** after an explicitly allowlisted user clicks Approve. Three layers:

### (1) Pure policy logic — `assistant/guardrails.mjs` `[generalizable-any-agent]`

`evaluateToolCall(tool, policy, state) → {mode, kind, reason}` is decoupled from Slack, network, and the LLM (so it unit-tests trivially). It has **two consumers** — the Slack adapter (force-propose) and `cli.mjs` (graduated `--allow-actions`/`--execute` flags) — which is the proof that the policy is surface-independent. Design:

- **Two-axis policy:** a master `allowActions` switch separate from an `execute` flag, yielding three modes: **blocked → dryrun → execute**. The middle `dryrun` state is what makes the human-in-the-loop UX possible — the LLM fully describes intent with no side effect.
- **Read-by-default:** `toolKind()` treats a missing `kind` as `'read'`; only `kind:'action'` tools are gated. Read tools **always execute** regardless of policy, so Q&A never breaks. Fail-safe: a newly added tool is harmless unless opted into action-gating.
- **Conservative `DEFAULT_POLICY`:** `allowActions:false, execute:false, maxActions:5, allowedTools:null`. Secure-by-default — out of the box the agent is read-only.
- **Evaluation ordering matters:** `allowActions` → `allowedTools` → execute/dry-run split → `maxActions` cap. A tool not on `allowedTools` is **blocked even in dry-run** — it can't even be proposed. (severity low gotcha)
- **`maxActions`** caps executed actions per run against `state.actionsExecuted` (incremented only for `kind:'action'` executes); read tools don't count. Bounds blast radius.
- Returns a human-readable `reason` that drives both behavior and user-facing messages.
- **Test coverage:** `guardrails.test.mjs` covers all **six branches** — read-always-execute, action-blocked-by-default, `allowActions` without `execute` → dryrun, `allowActions`+`execute` → execute, allowlist-blocks, `maxActions`-caps.

### (2) Identity binding — `assistant/slack/permissions.mjs` `[generalizable-any-agent]`

`policyForUser(userId, {actionUsers, allowDryRunForAll})` maps a user id to a guardrail policy: allowlisted → `{allowActions:true, execute:true}`; else read-only (or dry-run-only if `allowDryRunForAll`). Keeps the guardrail identity-agnostic. `parseActionUsers` tolerates comma **or** whitespace separated ids. `resolveActionUsers(inst, cfg)` picks per-workspace `cfg.actionUsers`, falling back to `ENV_ACTION_USERS` (`SLACK_ACTION_USERS`) for the legacy single-workspace deploy.

### (3) Slack wiring — `server.mjs`

- **Two-phase approval:** the message handler runs the agent with `{...policyForUser(...), execute:false}` and `allowDryRunForAll:true` for **every** requester (~line 200). Even an allowlisted user's request is downgraded to a proposal so everything flows through the visible Approve/Reject card. The propose-time identity is **not trusted** for execution.
- **Re-authorize at click time** (~line 257): `handleInteraction` checks `resolveActionUsers(...).has(payload.user.id)` — the **clicker**, not `pend.requestedBy` — before running the handler. Anyone may request; only an allowlisted user may approve/execute. Non-authorized clickers get an ephemeral "not authorized" reply via `payload.response_url`.
- **Bootstrap:** a fresh workspace starts with `actionUsers:[]`; without the installer auto-add, nobody could ever approve. `addActionUser(teamId, installedBy)` in the OAuth callback seeds the first trusted approver.

### Pending-action store — `assistant/slack/pending.mjs` `[generalizable-slack]`

`putPending` stores `{tool, input, requestedBy, team, channel, thread}` at `pending:act_<crypto.randomBytes(8).hex>` with a **30-min TTL** and returns the id (carried in the button's `value`). **`peekPending`** reads without removing (validate before executing); **`takePending`** reads-and-deletes (resolve).

- Random ids avoid cross-replica collisions a process counter would cause; TTL lets proposals survive a redeploy and auto-expires stale ones.
- **Peek-then-take ordering matters (severity medium):** if you `take` (delete) before the auth check and the clicker turns out unauthorized, you've destroyed a still-valid proposal. There's a small TOCTOU window (two clickers both peek), mitigated in practice by `takePending` + the terminal `chat.update` that replaces the buttons.

### Approval card — Block Kit

`approvalBlocks(id, tool, input)` builds a `section` (mrkdwn) + `actions` block with `action_id` `approve_action`/`reject_action` (primary/danger styled), `value=id`. `summarizeInput` renders the proposed input compactly (truncated ~120 chars). One card per dry-run entry found in the agent's `audit`. After resolution, `chat.update` (channel + `message.ts`) replaces the buttons with a terminal status line so a resolved proposal can't be re-clicked.

### Critical trust dependencies (gotchas)

- **(high)** The whole allowlist is meaningless without upstream signature verification — a forged interaction payload could claim any clicker id. Signature verification (`verify.mjs`) is the foundation the entire trust model sits on.
- **(high)** `policyForUser` returns `execute:true` for privileged users; the Slack caller spreads **again** to force `execute:false`. Forgetting that second spread would let an allowlisted user's actions auto-execute without a button. Be explicit at the call site about propose-vs-auto-execute.
- **(medium)** Tool handlers run from two places (`agent.mjs` when policy says execute, and `server.mjs handleInteraction` on Approve) and must accept the **same context shape** (`{channel, thread, team, postMessage}`) — divergence causes approve-path-only bugs.

### System prompt teaches the three outcomes truthfully `[generalizable-any-agent]`

`DEFAULT_SYSTEM`/`SLACK_SYSTEM` instruct the model: on `{blocked}` tell the user actions need enabling and **don't retry**; on `{dryRun}` say exactly what it would do and that an Approve card is shown; never claim success unless the tool result confirms it. The guardrail isn't only mechanical — the model must be prompted to represent blocked/dry-run states honestly so it doesn't hallucinate success.

---

## 6. Agent Loop, Tools, Memory & Cost Tracking

### The loop — `assistant/agent.mjs` `[generalizable-any-agent]`

A single generic Anthropic agentic loop with a fixed **`MAX_STEPS=6`** cap and **`max_tokens=1024`**:

- Tools are passed in as `{name, description, input_schema, handler}` objects; the file builds `toolDefs` (for the API call) and a `byName` Map (for dispatch). **The loop never changes when adding capabilities** — adding a tool = adding an object to the array. Both `cli.mjs` and `slack/server.mjs` compose the same tool arrays.
- Mechanics: create message → push assistant content → if no `tool_use` blocks return final text → else run handlers, push `tool_result` blocks as a user turn → repeat to the step cap. Returns `{text, calls, audit, convo, usage}`.
- **Uniform context** `{channel, thread, user, team, postMessage}` passed as the second arg to **every** handler — `handler(input, context)`. Tools that don't need it ignore it.
- **Action gating** consults `evaluateToolCall`; on `mode==='dryrun'` the handler is **skipped entirely** and a synthetic `{dryRun, wouldCall, withInput}` is returned (running the handler here would cause the very side effect the gate prevents — severity high). Every action decision is recorded in an `audit` array with mode `executed`/`dryrun`/`blocked`; the Slack layer iterates `audit.filter(mode==='dryrun')` to build cards.
- **Defensive:** unknown tool name → `{error:'unknown tool X'}` fed back as a `tool_result`; handler exceptions caught → `{error: e.message}`. The model sees the error and adapts.
- **Memoized client:** `getClient` caches `_client`/`_clientKey`, re-creating only if the API key changes (one `runAgent` per Slack message).
- **Time stamping:** current UTC time is appended to the system prompt each run, and the prompt instructs the model to stamp live counts with "(as of HH:MM UTC)" and to treat the feed as live ("it moves between readings — that is expected").

> **Sharp edge to generalize:** `MAX_STEPS=6` and `max_tokens=1024` are hardcoded (fine for short Slack chat, but 1024 truncates longer reports and 6 caps deep multi-tool tasks). A reusable skill should surface these as parameters. (severity low)

### Conversation memory — `assistant/slack/memory.mjs` `[generalizable-any-agent]`

Stores **simplified text turns** (`[{role:'user'},{role:'assistant'}]` — user question + final answer) keyed by `mem:team:channel:thread`, **1h TTL, last 8 pairs**. `getHistory`/`appendTurn` feed `runAgent`'s `history`.

> **GOTCHA (high):** re-feeding the raw `convo` tool-cycle array can leave a `tool_use` block with no matching `tool_result`, which the Anthropic API rejects with a 400. Simplified text turns are always valid replay history. Documented in the module header.

### Cost tracking — `assistant/usage.mjs` `[generalizable-any-agent]`

`recordUsage(teamId, {input, output})` increments `usage:<team>:<YYYY-MM-DD>` (TTL ~40 days) from `runAgent`'s returned usage; `server.mjs` logs per-message and per-day totals. **Observe-only — no cap enforced yet.** Tokens are the true cost unit (output costs several × input); record real numbers first to size a credit/limit later from data rather than guessing.

### Domain tools (`worldmonitor-specific`)

- **`relay.mjs`** — `relayGet(path)` wraps fetch against `RELAY_URL` with an optional shared-secret header (`RELAY_AUTH_HEADER`/`RELAY_SHARED_SECRET`), throwing on non-2xx. **All** freight/weather tools call `relayGet` — one place for base URL, auth, and error shape. (Env binding centralized in `config.mjs`.)
- **`tools/freight.mjs`** — `find_freight_vessels` etc.
  - **GOTCHA (medium):** a local filter (name/destination/delayedOnly) over relay-paginated data would silently miss matches past the first page (the relay only filters by operator server-side). The tool detects any local filter and bumps the fetch limit to the full set (**3000**) before filtering. When the backend only filters some fields server-side, pull the full set before any client-side filter.
  - **Freshness caveat pattern** (see §9): `feedNote(j)` attaches a compact `feed` field only when data is warming/stale; tool descriptions instruct the model to **lead** with that caveat. `[generalizable-any-agent]`
- **`tools/weather.mjs`** — Open-Meteo marine + wind (free, no key).
- **`tools/actions.mjs`** — `save_freight_report` writes a model-supplied filename to disk. **GOTCHA (high, path traversal):** sanitizes to `[a-zA-Z0-9._-]`, collapses repeated dots, strips leading dots, forces `.md`, and joins under a fixed `REPORTS_DIR`. Any file-writing action tool needs this.
- **`post_report_to_channel`** — a Slack-only action tool whose handler receives live `ctx={channel, thread, postMessage}` at execution time, so the LLM can "post to this channel" without knowing channel ids. The same ctx is passed during agent run and on button approval, so dry-run and execute share the contract.

---

## 7. Onboarding & Background Watches

### Onboarding — `assistant/slack/onboarding.mjs` `[generalizable-slack]`

**Dual-trigger, idempotent welcome DM:**
- The **OAuth callback** greets the installer (only fires for the installer).
- **`app_home_opened`** greets any teammate who opens the Home tab (catches those who never ran the install — the key non-obvious trigger).
- Both gated by a persisted per-workspace **`cfg.onboarded`** flag (set via `setConfig` after either path) so nobody is DM'd twice. (`server.mjs` ~174–181 and ~302–307.)

**GOTCHA (medium):** `app_home_opened` fires for the bot's own events too — guard with `ev.user !== botUserId` **and** the `onboarded` flag (both present at `server.mjs:177`).

**Persona-as-preamble:** `MARCO_PERSONA` (a warm Italian logistics colleague) is **prepended** to the base data-discipline system prompt, not a replacement. Keeping voice separate from data-grounding rules prevents the personality from loosening factual constraints. Includes the same-language reply rule (see §9).

### Watches — `assistant/watches.mjs` `[generalizable-any-agent]`

User-defined background subscriptions the server ticks on an interval, alerting on state changes.

- **State-change-only alerting with a silent baseline:** `lastState` starts `null`; the **first** evaluation records state and fires **no** alert; subsequent evals only emit when state changed (`lastState !== null && changed`). Eliminates startup/creation alert storms — a port already congested when you create the watch should not immediately fire. Locked by the test "silent baseline, alerts on transition, no repeat."
- **Alerts can be gated to a specific *directional* transition**, not just any change — e.g. fire only when congestion *clears* (a → b but not b → a). This is load-bearing when reusing `evaluateWatches`: the baseline machinery records the previous state, and the condition decides whether *this particular* transition is alert-worthy. Don't assume "state changed" always means "alert."
- **Pure-core evaluator:** `evaluateWatches({ports, vessels})` takes **pre-fetched** data so it is fully unit-testable with no network/mocks; the server does the I/O (`relayGet`) and hands results in.
- **Set-index + per-item KV with self-pruning:** an index set `'watches'` of ids plus one `watch:<id>` entry each; `listWatches` removes ids whose value is gone (`setRem`).
- **Per-workspace token for proactive posts:** each watch stores its own `team`; `tickWatches` (`server.mjs` ~408–413) resolves `getInstallation(watch.team).botToken` before posting (a watch created in workspace A must post with A's token).
- **`cancelWatchesForTeam(team)`** iterates `listWatches()` and cancels those where `w.team === team`, returning a count (logged). Wired into the uninstall handler to honor the privacy policy. The test asserts team-scoped isolation: purging `T_A` leaves `T_B`'s watch intact.

**GOTCHA (low):** the background ticker — wrap the whole tick in try/catch (log + swallow transient fetch errors), short-circuit when there are zero watches (avoid pointless data fetches), and call `.unref?.()` on the `setInterval` so the timer doesn't block process exit (`server.mjs` ~399–426).

---

## 8. Legal & Distribution

### Self-served legal pages — `assistant/slack/legal.mjs` `[generalizable-slack]`

Slack public distribution **requires** public Privacy Policy **and** Support URLs. Marco serves `/privacy` and `/support` as HTML **from the app process itself** via `privacyHtml()`/`supportHtml()`, built from single-source constants (`SUPPORT_EMAIL`, `ENTITY`, `UPDATED`) and a shared `page()` shell.

Benefits: the URLs exist the moment the service is up (no separate static host to provision/deploy/keep in sync), and the legal copy is reviewable in PRs so reviewers can catch policy-vs-behavior drift.

### Distribution activation (UI-only, not in the manifest)

**GOTCHA (medium):** "Manage Distribution" settings — Privacy Policy URL, Support URL, "Remove Hard Coded Information", "Activate Public Distribution" — are **not** in the app manifest and must be set in the api.slack.com UI. The manifest gets you ~90% there; budget UI steps for distribution + legal URLs. App Directory listing (Slack review) is optional and later — the direct install link works immediately.

### Health endpoint

`GET /health → { ok:true, multiTenant:true, installs:<n> }` — cheap operational signal that the multi-tenant store is wired and how many workspaces are installed. Useful for deploy verification and monitoring. `[generalizable-slack]`

---

## 9. Display & i18n Gotchas

These came directly from live use and the fix PRs (#30).

- **Timezone (medium):** the freshness badge rendered time as UTC ("as of 15:18:00 UTC") for an Italian/Amsterdam audience. **Lesson:** show timestamps in the **audience's** wall-clock zone, computed **DST-aware** via `Intl.DateTimeFormat` with an explicit IANA `timeZone` ('Europe/Amsterdam') — never a hardcoded offset. `clockAmsterdam(epochMs)` in `src/services/logistics/freshness.ts` uses `{timeZone:'Europe/Amsterdam', hour:'2-digit', minute:'2-digit', hour12:false, timeZoneName:'short'}` to print "HH:MM CET"/"CEST" correctly, tested at both a summer (CEST) and winter (CET) instant. `[generalizable-any-agent]`
- **Badge collision (low):** a long live badge ("as of 15:18:00 UTC") in a `justify-content:space-between` flex header consumed the free space and collapsed the adjacent count flush against it, rendering "UTC171". **Lesson:** in a space-between header a variable-width sibling can eat all the gap — don't rely on layout free space for separation; put a guaranteed `margin-inline-start` on the element that must never touch its neighbor, **and** shorten the variable text (drop seconds: "HH:MM" not "HH:MM:SS") so it can't grow unbounded. (`src/styles/main.css`.)
- **Reply-in-user-language (medium):** the model answered in Italian to a bare "ciao" inside an otherwise-English conversation. **Lesson:** give an explicit persona rule — "ALWAYS reply in the SAME language the user wrote in" — **plus a greeting carve-out**: "a bare 'ciao' is just a greeting, not a language choice — if the rest of the conversation is in English, stay in English." The carve-out stops a single foreign greeting from flipping the whole conversation's language. (`assistant/slack/onboarding.mjs`.) `[generalizable-any-agent]`

### Shared freshness module (cross-surface consistency) `[generalizable-any-agent]`

Freshness decision logic lives in **one pure computation** consumed by three surfaces so they can never disagree:
- `scripts/freshness.cjs` — `relayFreshness({lastPollAt, tilesSeen, tileCount}) → {warming, stale, ageSec}` (relay/Node). Note `tilesSeen` is passed as a **number** (`set.size`), not the Set itself.
- `src/services/logistics/freshness.ts` — `describeFreshness(meta) → badge` (FE), mirrors the CJS logic.
- `assistant/tools/freight.mjs` — `feedNote(j)` turns the same meta into a one-line caveat.

**The "absent meta ⇒ fresh" convention is applied at two layers, in two different files — know the distinction when reusing:**
- **Disable-gate (one layer up):** `feedFreshness()` in `scripts/ais-relay.cjs` returns `{}` when the producing feed is *disabled* (no `MARINESIA_API_KEY` ⇒ no poll ⇒ `lastPollAt` null). Emitting nothing lets clients treat absent meta as fresh — see §12 for why this matters.
- **Happy-path-absent (tool layer):** `feedNote(j)` returns `null` when data is fresh, and tools spread it as `...(feed ? { feed } : {})` so the `feed` field is simply absent on the happy path.

Same contract — *absent meta means fresh* — enforced once where the signal is produced (disable-gate) and once where it's surfaced to the model (tool field). The provider (`src/services/logistics/providers/aisstream.ts`) captures response meta into `lastMeta` on each fetch.

---

## 10. Testing Approach

The codebase is structured so the hard logic is **pure and network-free**:

- **`assistant/guardrails.test.mjs`** — covers all **six branches** of `evaluateToolCall` (read-always-execute, action-blocked-by-default, `allowActions` w/o `execute` → dryrun, `allowActions`+`execute` → execute, allowlist-blocks, `maxActions`-caps) with no network, since the guardrail is a pure decision function returning `{mode, kind, reason}`.
- **`assistant/watches.test.mjs`** — runs entirely network-free because `evaluateWatches({ports, vessels})` takes pre-fetched data. Locks the "silent baseline, alerts on transition, no repeat" behavior and the team-scoped purge isolation (purging `T_A` leaves `T_B` intact).
- **`assistant/slack/oauth.test.mjs`** — injects a `fakeFetch` returning a canned `oauth.v2.access` body and asserts the normalized installation shape; `authorizeUrl` is asserted by parsing the URL's `searchParams`. Possible because `exchangeCode({...,fetchImpl=fetch})` and `authorizeUrl` are pure/injectable.
- **`assistant/slack/installations.test.mjs`** — exercises the per-tenant store (save/list/remove, index pruning) against the in-memory KV fallback.
- **`scripts/freshness.test.cjs`** + **`tests/logistics-freshness.test.mts`** — cover DST, clock skew, and tile-sweep edge cases; the timezone formatter is tested at both a CET (winter) and CEST (summer) instant.

**Principles to carry forward:** (1) keep the security/approval decision a pure function; (2) make evaluators take pre-fetched data; (3) make OAuth/protocol functions injectable (`fetchImpl`, `now`) so verification and token exchange test without a network; (4) the in-memory KV fallback doubles as the test backing store (zero infra in CI).

---

## 11. Deployment & Ops

**Hosting:** Railway, **multi-replica** — this is *the* reason OAuth CSRF state, pending approvals, install tokens, memory, and watches must live in shared KV, not process memory.

**Go-live sequence (order is load-bearing) — `MARCO_SETUP.md`:**
1. **Deploy the service first**, then create/update the Slack app. Pasting the Events Request URL triggers Slack's verification challenge **immediately** — the endpoint must already be live and answering `/slack/events`, or the manifest/event-subscription save fails. (severity high)
2. Create the app from `marco-app-manifest.json` (one paste sets scopes/events/redirect/interactivity/App Home).
3. Set env vars on Railway (see below).
4. In the api.slack.com UI: set Privacy + Support URLs, "Remove Hard Coded Information", "Activate Public Distribution" (manifest doesn't cover these).
5. Customers self-install via the public "Add to Slack" link.

**Environment variables** (centralized binding in `assistant/config.mjs`):
- Multi-tenant: `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_SIGNING_SECRET`, optional `SLACK_REDIRECT_URI` (else derived from request host).
- Legacy single-tenant fallback: `SLACK_BOT_TOKEN`, `SLACK_BOT_USER_ID`, `SLACK_ACTION_USERS`.
- Persistence: `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` — **required** once multi-workspace (without them, every redeploy logs out all customers — severity high).
- Agent: `ANTHROPIC_API_KEY`, optional `ASSISTANT_MODEL` (default `claude-sonnet-4-6`).
- Domain data: `RELAY_URL`, `RELAY_SHARED_SECRET`, `MARINESIA_API_KEY` (gates freshness signals — see §12).
- Misc: `WATCH_TICK_MS`, `PORT` (default 3010).

**Ops gotchas:**
- After editing scopes/events, **reinstall** the app to the workspace or changes don't take effect (silent failure). (severity low)
- Local dev can use ngrok to expose a public Request URL.

---

## 12. Hard-Won Lessons (from the fix PRs)

**Cross-cutting category — *served-contract-vs-actual-behavior drift*.** Three of the lessons below (#29's privacy-policy claims, #27's freshness-caveat audit, and policy-vs-code drift generally) are the same discipline: anything the system *asserts* to users — a retention policy, a data-quality caveat, a freshness badge — is a **testable claim** that must be diffed against what the code actually does. Treat served contracts as specs, not copy.

- **Privacy policy is a testable spec, not marketing copy (#29, high).** `/privacy` claimed "watches removed when you uninstall" but `removeInstallation()` only cleared install/config keys — `watch:*` lingered; and it claimed ~120-day usage retention while `usage.mjs` TTL was ~40 days. **Fix:** added `cancelWatchesForTeam(team)` wired into the `app_uninstalled`/`tokens_revoked` handler (making the deletion claim true) and corrected the text to ~40 days. **Diff every retention/deletion claim against actual TTLs and delete paths. Prefer making the code honor the stricter claim; only weaken the text when the real behavior is already safe.**

- **Count DISTINCT, not total, when tracking "covered all of set X" (#27, medium).** The freshness "warming" flag was driven by `pollsOk >= tileCount` (total successful tile polls). A tile that kept failing during cold start could be masked by duplicate successes from other tiles in later sweeps, clearing "warming" while one tile was still empty. **Fix:** changed `marinesiaPollsOk` (number) → `marinesiaTilesSeen` (Set) and passed `tilesSeen = set.size`. Total counts let repeats mask never-seen items — count a Set's size.

- **Gate a health/freshness signal on the producing feed being ENABLED (#27, medium).** Freshness was emitted unconditionally, but with no `MARINESIA_API_KEY` the Marinesia poll never runs (`lastPollAt` stays null) — the old code then marked live aisstream-backed data as permanently "warming"/"stale". **Fix:** `feedFreshness()` returns `{}` when the feed is disabled; clients treat absent meta as fresh (the same "absent ⇒ fresh" contract surfaced at the tool layer — see §9). Don't let a never-started poller's null state masquerade as a stalled live feed.

- **Audit EVERY surface of the same numbers when adding a caveat (#27, low).** The freshness caveat was first added only to count-returning tools; `get_port`, `get_delayed_vessels`, and `get_vessel` also quote counts/lookups but lacked it. A caveat inconsistent across tools is worse than none — the model sounds authoritative on the un-caveated path.

- **Show audience-local, DST-aware time; don't let one greeting flip language (#30).** See §9 — `Intl.DateTimeFormat` with an explicit IANA zone, and the same-language persona rule with a "ciao" carve-out.

- **Don't rely on flex free-space for separation (#30, low).** The "UTC171" badge collision — guaranteed `margin-inline-start` + shortened variable text. See §9.

- **Move CSRF state and pending records out of process memory; use random ids (history).** The `/install`→`/callback` halves and propose-then-approve can land on different replicas and must survive redeploys; process memory breaks across instances and a process counter collides. Use shared KV + `crypto.randomBytes` ids.

---

## 13. Skill Blueprint — Extract vs Strip

A checklist for turning Marco into a **reusable Slack-agent skill**. Modules tagged `generalizable-any-agent` or `generalizable-slack` are extraction candidates; `worldmonitor-specific` code is the seam to parameterize or strip.

### Extraction order (the dependency spine)

Extract in this order — `store.mjs` and `verify.mjs` have **zero internal deps** and come first; everything else builds on them:

```
store.mjs  +  verify.mjs              (no internal deps — foundations)
        ↓
server.mjs backbone                   (HTTP routing, needs verify + store)
        ↓
oauth.mjs  +  installations.mjs       (install flow, need store)
        ↓
guardrails.mjs  +  permissions.mjs  +  pending.mjs   (action policy, need store)
        ↓
agent.mjs                             (the loop, consumes guardrails)
        ↓
memory.mjs  +  usage.mjs  +  watches.mjs   (per-tenant state on store)
        ↓
onboarding.mjs  +  legal.mjs  +  manifest   (lifecycle / distribution)
```

### A. Extract verbatim or near-verbatim (`generalizable-slack` / `generalizable-any-agent`)

- [ ] **`assistant/store.mjs`** — Upstash-REST-or-in-memory KV behind one API. *(Extract first — zero internal deps.)*
- [ ] **`assistant/slack/verify.mjs`** — Slack signature verification. Copy as-is. Foundation of the whole trust model. *(Extract first — zero internal deps.)*
- [ ] **`assistant/slack/server.mjs` backbone** — the raw-http skeleton: GET(unsigned)/POST(signed) split, verify-then-parse, `url_verification` challenge, ack-fast + detached handler, `event_id` dedupe Set, loop-prevention filters, `apiFor(botToken)` token-bound helper factory. Strip the worldmonitor tool wiring and watch-ticker data fetch (see §C).
- [ ] **`assistant/slack/oauth.mjs`** — pure `authorizeUrl`, KV-backed single-use CSRF state (`newState`/`consumeState`, 10-min TTL), injectable `exchangeCode` that normalizes to a flat install shape.
- [ ] **`assistant/slack/installations.mjs`** — per-`team_id` install + config store with set-based index, self-pruning list, config-merged-over-defaults, idempotent `addActionUser`.
- [ ] **`assistant/guardrails.mjs`** — pure three-state action policy (`evaluateToolCall`). Tool-agnostic; copy with its test (six branches).
- [ ] **`assistant/slack/permissions.mjs`** — `policyForUser`, `parseActionUsers`, `resolveActionUsers` (with env fallback).
- [ ] **`assistant/slack/pending.mjs`** — redeploy-safe pending-approval store (random ids + 30-min TTL, peek vs take).
- [ ] **`assistant/agent.mjs`** — the generic tool-use loop. **Parameterize `MAX_STEPS` and `max_tokens`** (currently hardcoded 6 / 1024) when generalizing.
- [ ] **`assistant/slack/memory.mjs`** — simplified-text-turn conversation memory (never raw tool cycles).
- [ ] **`assistant/usage.mjs`** — observe-only per-workspace/per-day token metering.
- [ ] **`assistant/watches.mjs`** — state-change-only alerting with silent baseline + directional-transition support + `cancelWatchesForTeam`. The **evaluator** (`evaluateWatches`) is generalizable; the **conditions** it checks are domain-specific (see §C).
- [ ] **`assistant/slack/onboarding.mjs`** — dual-trigger idempotent onboarding DM + persona-as-preamble + same-language rule.
- [ ] **`assistant/slack/legal.mjs`** — self-served `/privacy` + `/support` from constants.
- [ ] **`assistant/slack/marco-app-manifest.json`** — manifest-as-code template (scopes/events/redirect/App Home).
- [ ] **Patterns to encode as conventions:** propose-then-approve human-in-the-loop; re-authorize the clicker not the requester; ack-within-3s + dedupe; `apiFor` token-binding; **self-healing reads** (prune dangling index members on read — appears 3× independently in `listInstallations`, `listWatches`, and the generic set-index pattern; elevate it to one convention); path-traversal sanitization for any file-writing tool; data-quality caveat field absent-on-happy-path; audience-local DST-aware timestamps; "one pure freshness/health module, many surfaces"; one guardrail with two consumers (CLI flags vs Slack force-propose).

### B. Project-specific seams to PARAMETERIZE (the configuration surface of the skill)

- [ ] **System prompt / persona** — `MARCO_PERSONA`, base data-discipline `DEFAULT_SYSTEM`/`SLACK_SYSTEM`, and the time-stamping/freshness narration. Make persona + base prompt injectable.
- [ ] **Bot scopes & events** in the manifest — parameterize for the app's needs (Marco's set is a least-privilege starting point).
- [ ] **Legal copy constants** — `SUPPORT_EMAIL`, `ENTITY`, `UPDATED`, and every retention/deletion claim (must match real TTLs — see §12).
- [ ] **Config schema** — `DEFAULT_CONFIG` (`{ports, operators, actionUsers, onboarded}`): keep `actionUsers`/`onboarded`, replace `ports`/`operators` with the new domain's config keys.
- [ ] **Tunables** — `MAX_STEPS`, `max_tokens`, watch TTL/interval (`WATCH_TICK_MS`), memory window (8 pairs / 1h), usage TTL (~40d), pending TTL (30m), dedupe cap (1000).
- [ ] **Audience timezone** — the hardcoded `Europe/Amsterdam` IANA zone is worldmonitor-specific; expose as config.
- [ ] **`assistant/config.mjs`** — the **env-binding seam**: `RELAY_*` / `SLACK_*` / `UPSTASH_*` / `ANTHROPIC_*` are all read here (e.g. `relay.mjs` imports from it). This file *is* the env contract; re-point the domain-data vars and keep the platform ones. The full env list lives in **§11** — that env contract (`SLACK_*` / `UPSTASH_*` / `ANTHROPIC_*` / domain `RELAY_*` / `MARINESIA_*`) is part of the configuration surface, not an afterthought.
- [x] **Generalized delivery record (BUILT — see §14; `MULTI_PLATFORM.md`)** — replaced Slack-specific `{teamId, botToken}` with `{platform, tenantId, deliver, installedBy, installedAt}` and a single `send(install, {channelId, threadId, text, blocks})` that branches on `install.platform`. The watch ticker and approval flow now call `send()` instead of `slackApi` directly. **This is the seam the Teams adapter plugs into, and Teams is *not* a clone of Slack's token model:**
  - Teams has **no per-tenant token** — there's a single app credential plus a **stored conversation reference** per channel; you cannot "post to a channel by id" without that reference.
  - Teams' `serviceUrl` is **regional and can change** — always store the latest `serviceUrl` seen on inbound activity and use it (plus the stored conversation reference) for proactive sends; never hardcode it.
  - Approve/Reject buttons map to Teams **Adaptive Cards** (the pending-action flow in `pending.mjs` is otherwise unchanged).
  - These are exactly why `deliver` is abstract: a Slack `deliver` is a bot token, a Teams `deliver` is `{serviceUrl, conversationReference}`.

### C. Strip / replace (`worldmonitor-specific`)

- [ ] **`assistant/relay.mjs`** — the authenticated GET client to the AIS/ports backend (`RELAY_URL`, `RELAY_SHARED_SECRET`). Replace with the new domain's data client.
- [ ] **`assistant/tools/freight.mjs`, `tools/weather.mjs`, `tools/watches.mjs`, `tools/actions.mjs`** — domain tools. Replace with the new domain's tool objects (the loop and registry pattern stay; only the tool array changes).
- [ ] **`post_report_to_channel` / `save_freight_report`** — Marco's specific action tools (keep the *patterns*: live-ctx injection, filename sanitization; drop the freight specifics).
- [ ] **The shared freshness module** (`scripts/freshness.cjs`, `scripts/ais-relay.cjs`'s `feedFreshness`, `src/services/logistics/freshness.ts`, `aisstream.ts`, the FE badge/CSS) — keep the *pattern* (one pure module → backend/FE/agent, with the disable-gate + happy-path-absent two-layer convention), strip the AIS-tile-sweep specifics; re-implement for whatever liveness signal the new domain has (or omit).
- [ ] **Watch condition logic** — the *what* a watch evaluates (port congestion, delayed vessels) is domain-specific; keep `evaluateWatches`'s baseline/transition machinery (including directional transitions), swap the conditions.
- [ ] **Marinesia / aisstream / Open-Meteo deps & their env vars** — domain data sources; remove.

### After extracting — the load-bearing invariants to re-test

These are the high-severity gotchas that **silently break on copy**. Re-verify each before trusting the extracted skill:

1. **Signature-verify-BEFORE-parse** — confirm no body parser runs ahead of `verifySlackSignature` over the raw body (the #1 cause of Slack signature failures). (§4)
2. **Ack-within-3s + dedupe** — confirm the handler 200s before the slow LLM call and dedupes by `event_id`. (§4)
3. **Force `execute:false` at the Slack call site** — confirm the second spread (`{...policyForUser(...), execute:false}`) survived; without it, allowlisted users' actions auto-execute with no button. (§5)
4. **Re-auth the clicker, not the requester** — confirm `handleInteraction` checks `payload.user.id` against the allowlist at approval time. (§5)
5. **No-token uninstall path** — confirm `app_uninstalled`/`tokens_revoked` are handled before any token lookup and purge all team-scoped data. (§4, §7)
6. **Durable KV in prod** — confirm `PERSISTENT` is true (Upstash creds present) or every redeploy silently de-installs all workspaces. (§3)
7. **Memory stores simplified text turns, not raw `convo`** — confirm replay history never contains a dangling `tool_use` block (Anthropic 400). (§6)

**Net:** the entire `assistant/slack/*` adapter (minus tool wiring), `agent.mjs`, `guardrails.mjs`, `store.mjs`, `usage.mjs`, `memory.mjs`, `permissions.mjs`, `pending.mjs`, and the `watches.mjs` machinery form the reusable Slack-agent skill. The single configuration surface is: persona/prompt, manifest scopes/events, legal constants, config schema, tunables, audience timezone, the env contract (`config.mjs` + §11), and a `send()` delivery abstraction. The data plane (`relay.mjs` + `tools/*` + freshness) is the swappable domain.

---

## 14. Teams Adapter — The Second Platform (built + validated, 2026-06)

Marco now answers on **Microsoft Teams** from the *same* brain that serves Slack — the `MULTI_PLATFORM.md` "one brain, two thin adapters" bet, realized and verified live in production. The platform-neutral core (`agent.mjs`, `tools/*`, `guardrails.mjs`, `watches.mjs`, `usage.mjs`, `store.mjs`, conversation memory) was reused **unchanged**; only *receive → run → send* is Teams-specific. Building it surfaced a cluster of Bot Framework gotchas worth their own chapter. Teams-portable items are tagged `generalizable-teams`.

### 14.1 Neutral host + the delivery seam (what made two platforms cheap) `[generalizable-any-agent]`

The two refactors that made Teams a **peer** of Slack rather than a fork:
- **`assistant/server.mjs`** — a neutral HTTP host owns `http.createServer`, `readBody`, dispatch (GET → Slack browser/OAuth/legal; `POST /api/messages` → Teams; other signed POST → Slack events/interactions), the watch ticker, and `/health`. Entry point is now `node assistant/server.mjs`.
- **`assistant/slack/adapter.mjs`** (renamed from the old `slack/server.mjs`) and **`assistant/teams/router.mjs`** export handlers the host mounts; neither owns the listener. This inversion is what makes "neutral core, two peer adapters" literally true in the file layout.
- **`assistant/send.mjs`** — the one delivery seam: `send/update/dm(install, {channelId, threadId, text, blocks})` branch on `install.platform`. The agent reply path, approval flow, and watch ticker call `send()` and never touch a platform API directly.

**Lesson:** the cost of a second platform is set *before* you add it — by whether delivery and the HTTP host are already abstracted. Do the neutral-host + `send()` seam refactors **first** (their own PRs); then the adapter is ~4 files (`teams/{verify,normalize,connector,router}.mjs`).

### 14.2 Teams ≠ Slack: the identity & token model `[generalizable-teams]`

The biggest conceptual difference from Slack's per-workspace OAuth token:
- **No per-tenant token.** Teams has **one global bot credential** (`MS_APP_ID` + `MS_APP_SECRET`). You don't store a token per customer; you store a **conversation reference** (serviceUrl + the channel accounts) captured from inbound activity, and resume it to send.
- **`serviceUrl` is regional and can change** — always use the `serviceUrl` from the latest inbound activity; never hardcode it (`smba.trafficmanager.net/<region>/…` for real Teams; Direct Line host for Web Chat).
- A Slack `deliver` is a bot token; a Teams `deliver` is a **conversation reference** `{ serviceUrl, from (bot), recipient (user), locale }`. `pending.mjs`, guardrails, memory, usage — all unchanged.

### 14.3 Receiving: JWT verify + normalize `[generalizable-teams]`

**`teams/verify.mjs`** — inbound activities are Microsoft-signed; verify before processing:
- Verify with **`jose` directly** (`createRemoteJWKSet` over the BF OpenID metadata + `jwtVerify`). **RS256 pinned** (reject `alg:none`/HS256 — algorithm confusion), `iss = https://api.botframework.com`, `aud = MS_APP_ID`.
- **serviceUrl anti-spoof:** require the token's `serviceurl` claim to equal the activity's `serviceUrl` (both trailing-slash-normalized); reject if either is missing. **Fail-closed** on unset `MS_APP_ID`.
- Then **ack within 5s** (Bot Framework's deadline) and dispatch async — same ack-fast discipline as Slack's 3s rule.

**`teams/normalize.mjs`** — pure mapping of an Activity to the neutral shape `{tenantId, channelId, threadId, userId, text, …}`:
- **Strip `<at>…</at>` mention spans** so the model sees a clean prompt (the Teams analog of stripping `<@U…>`).
- **`shouldRespond`:** personal (1:1) chat always answers; channel/groupChat only when the bot is **@mentioned**, verified against the bot's id in `activity.entities` (a `mention` whose `mentioned.id === recipient.id`) — **not** by parsing text (forgeable).
- Capture the **channel accounts** here (`botAccount = activity.recipient`, `userAccount = activity.from`, `locale`) — needed to build a valid reply (§14.4) and the seed of the proactive conversation reference (§14.11).

### 14.4 Replying: the connector + the "complete Activity" 400 `[generalizable-teams]`

**`teams/connector.mjs`** mints a client-credentials token (scope `https://api.botframework.com/.default`, cached + refreshed early) and POSTs the reply to `{serviceUrl}/v3/conversations/{conversationId}/activities/{activityId}`. Two gotchas, **both of which silently drop every reply while receive+ack succeed:**

- **(high) Token authority is tenant-specific for single-tenant bots.** A single-tenant bot must mint the Connector token from its **own tenant authority** (`login.microsoftonline.com/<MS_APP_TENANT_ID>/oauth2/v2.0/token`), **not** the `botframework.com` authority. Wrong authority → `unauthorized_client` → reply drops though inbound verified. (See also §14.7 — this same authority choice is the multitenant trap.)
- **(high) A reply must be a COMPLETE Activity.** The Connector does **not** infer `from`/`recipient`/`conversation` for a raw REST POST (no Bot Builder SDK) — a minimal `{type, text, replyToId}` body returns **HTTP 400**. Build it by **swapping the inbound accounts:** outbound `from` = inbound `recipient` (the bot), `recipient` = inbound `from` (the user), plus `conversation:{id}` and `replyToId`. (Fixed in #40; not Web-Chat-specific — 400s on real Teams too.)
- **URL hygiene:** strip a trailing slash from `serviceUrl` before appending `/v3/...` (the BF base URI ends in `/`), and `encodeURIComponent` the conversationId/activityId (Teams conversation ids contain `;`/`@`/`=`). **Log the response body** on a non-2xx send — the `AADSTS…`/error text is what tells you which gotcha bit.

### 14.5 The dependency crash that taught the clean-install gate `[generalizable-any-agent]` (severity high)

The first receive+verify PR **crashed production at boot** with `ERR_REQUIRE_ESM`: the JWT libs `jwks-rsa` (CommonJS) did `require('jose')`, but installed `jose` v6 is **ESM-only**. Local tests passed only because a *warm* `node_modules` still had a CJS-compatible jose; prod's **clean install** pulled ESM-only v6 → crash-loop.
- **Fix:** dropped `jsonwebtoken` + `jwks-rsa`; verify with **`jose` directly** (ESM-native, pure JS, no native build, one dep).
- **Lesson:** **gate every dependency change on a clean install + import-load check** (`rm -rf node_modules && npm ci`, then actually import the module), not a warm-`node_modules` run. (Saved as the `clean-install-gate-for-deps` memory.) *Local caveat:* a full clean install fails here on the frontend's `sharp` native build — use `npm install --ignore-scripts` (jose has no native build, so it's unaffected).
- **Recovery discipline under a prod crash:** **revert via PR** (don't push main directly), then re-land the fix on a clean branch.

### 14.6 Azure setup + the account-type wall `[generalizable-teams]`

From code-in-prod to a usable bot:
1. **Register an Azure Bot**, **Bot Type: Single Tenant**; messaging endpoint = `…/api/messages`.
2. Create a **client secret** (App Registration → Certificates & secrets) → `MS_APP_SECRET`. Capture `MS_APP_ID` + the home tenant id → `MS_APP_TENANT_ID`.
3. Add the **Microsoft Teams** channel.
4. Set the three env vars; the boot banner `[teams] Bot Framework endpoint on /api/messages` prints **only when `MS_APP_ID` is set** (the dormant/armed fingerprint).

**The wall (high):** **custom Teams apps can only be sideloaded in a *work/school* (Entra/M365) tenant.** A **personal** Microsoft account can't — the Teams Admin Center literally rejects it ("you can't sign in here with a personal account"). Testing in the real Teams client needs a work tenant (a free **Microsoft 365 Developer** sandbox, or a licensed user in your own tenant). The Azure portal has TWO same-named objects — the **Azure Bot resource** (Channels / Test in Web Chat / Configuration) and the **App Registration** (Authentication / Certificates & secrets); the "Manage Password" link bridges from the former to the latter.

### 14.7 The multitenant flip + the converted-bot authority trap `[generalizable-teams]`

To let *any* org install Marco (Viktor-parity distribution):
- **App Registration → Multitenant** (`signInAudience: AzureADMultipleOrgs`). The Authentication-blade radio **fails** with `api.requestedAccessTokenVersion is invalid` unless you also set **`requestedAccessTokenVersion: 2`** — edit the **Manifest** and change *both* fields in one save (multitenant requires access-token v2).
- **(high) Don't switch the connector to the `botframework.com` authority.** A bot **converted** single→multi has **no service principal in Microsoft's `botframework.com` tenant**, so that authority returns **`AADSTS700016 / unauthorized_client`** (properly-*created* MT bots get provisioned there; you can't admin-consent into Microsoft's tenant). **Keep `MS_APP_TENANT_ID` set** and mint from the **home-tenant** authority — the Connector token is **app-only for `api.botframework.com`** (validated by appId, not tenant-scoped), so per MS docs it delivers replies to any org's conversation. The `|| 'botframework.com'` default in `connector.mjs` is therefore a **footgun**: dropping the env var silently breaks every reply.
- For a **hand-rolled** bot the Azure Bot *resource's* type is largely cosmetic — only the **App Registration** audience (who can install) and **our** token authority (how we mint) matter.
- **Deprecation:** Microsoft deprecated *new* multi-tenant bot creation after **2025-07-31** (existing/converted keep working; modern path = single-tenant + user-assigned managed identity).

### 14.8 Validating without a work tenant — Test in Web Chat

The Azure Bot's **Test in Web Chat** (Direct Line) exercises the **same** `/api/messages` path — receive → JWT verify → agent → tools → generate → send — against prod, with **no Teams client or work tenant needed**. It's the fastest end-to-end probe; the server logs (`[teams] msg …`, `→ tools: … · replied N chars`, and any `send failed` / `bot token failed`) are ground truth. Every gotcha above was caught this way.

### 14.9 Teams rendering + persona `[generalizable-teams]`

Teams renders **standard Markdown** — `**bold**`, bullet lists, and small **tables** all work (Marco answers with vessel tables) — *unlike* Slack's mrkdwn (§4). `TEAMS_SYSTEM` reuses `MARCO_PERSONA` + the data-discipline base prompt with a Teams-markdown instruction. (TODO flagged in `teams/router.mjs`: `MARCO_PERSONA` + thread memory currently import from `slack/`; move them to neutral `persona.mjs` / `assistant/memory.mjs` now that Teams is the 2nd consumer.)

### 14.10 Distribution ladder + deploy fingerprinting

- **Sideload** (flat zip: `manifest.json` + `color.png` 192×192 + `outline.png` 32×32 at the root) → **Org catalog** (Teams Admin Center) → **AppSource** (Microsoft review). The one-click **"Add to Teams"** deep link (the "Add to Slack" analog) is `https://teams.microsoft.com/l/app/<AppId>`; reuses the same `/privacy` + `/support` pages. Runbook + the gotchas above live in `assistant/teams/TEAMS_SETUP.md`; the built zip is a gitignored artifact.
- **Deploy fingerprint (Railway):** `railway status --json` exposes each service's `latestDeployment.{status, meta.commitHash}` — watch `SUCCESS` on the new commit + `/health` 200. For **env-only** changes (same commit) fingerprint by the new deployment's `createdAt`, not the commit. (zsh gotcha: `status` is a read-only var — don't `read status …`.)

### 14.11 What's still ahead (not yet built)
- **④ Adaptive-card approval** — the propose-then-approve flow (`pending.mjs`, unchanged) rendered as Teams **Adaptive Cards** instead of Block Kit; `send.mjs` `update()`/`dm()` still throw `teams delivery not wired` until then.
- **⑤ Conversation-reference capture → onboarding DM + proactive watches** — persist the reference (a `conversationUpdate` is already logged on first contact) into a Teams install record so the watch ticker can `send()` proactively, and DM the installer the "Ciao…" magic-moment.
- **Cross-tenant delivery proof** — sideload in a work/dev tenant and confirm a home-tenant token delivers into *another* org's conversation (docs say yes; empirically unverified).

### Teams load-bearing invariants to re-test (the silent breakers)
1. **Verify before dispatch, fail-closed** — RS256-pinned, `iss`/`aud`/serviceUrl checked; reject on unset `MS_APP_ID`. (§14.3)
2. **Connector token from the HOME tenant authority** — not `botframework.com` (AADSTS700016). Keep `MS_APP_TENANT_ID`. (§14.4, §14.7)
3. **Reply is a COMPLETE Activity** — `from`/`recipient`/`conversation` present, or 400. (§14.4)
4. **Clean-install + import-load gate** before any dep change — the ESM crash class. (§14.5)
5. **serviceUrl from the latest inbound, never hardcoded** — regional + mutable. (§14.2)
