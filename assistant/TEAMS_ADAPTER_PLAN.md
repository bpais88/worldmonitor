# Teams Adapter — Implementation Plan

## 1. Goal & Viktor framing

Marco today is a native Slack AI coworker for Italian freight/maritime ops. Our competitor **Viktor.com** is a native AI coworker that runs on **both Slack and Teams** (Teams launched 2026-06-18). For a large share of Italian logistics, freight-forwarding, and port-authority customers, Microsoft Teams is the *only* sanctioned chat platform — so "Slack-only" is a hard disqualifier in those deals regardless of how good Marco is. **Adding a Teams adapter closes the single biggest platform gap with Viktor**: same brain, same persona, same freight intelligence, now reachable where these customers actually work. To be explicit about scope: this work delivers **chat + approval-gated actions + proactive watch alerts on Teams**, at parity with what Marco already does on Slack. It does **not** chase Viktor's broader surface — the ~3,200 third-party integrations, in-chat code execution, or generic workflow automation. Those are separate bets; this is purely "Marco, on Teams too."

## 2. Architecture recap — one brain, two thin adapters

The design in `MULTI_PLATFORM.md` holds and the research confirms it. The platform-neutral core is **reused unchanged**:

- `agent.mjs` (the Claude tool-use loop), `tools/` (freight, weather, watches, actions), `guardrails.mjs`, `usage.mjs`, `store.mjs`, `slack/memory.mjs`.
- `watches.mjs` — fully neutral: `evaluateWatches` returns `[{ watch, message }]` with no Slack coupling; `watch.channel`/`watch.thread`/`watch.team` are opaque strings. **No change.**
- `pending.mjs` — fully neutral: `putPending`/`peekPending`/`takePending` store opaque `channel`/`thread`. **No change.**
- `onboarding.mjs` — `MARCO_PERSONA` is platform-neutral and reused verbatim. `onboardingText()` currently emits Slack mrkdwn (`<@U…>`, `*bold*`, `• `) and needs a Teams-flavored renderer (see §7).

An adapter does exactly three things: (1) receive platform events → normalize to `{ tenantId, channelId, threadId, userId, text }`; (2) `runAgent({ …, context })`; (3) send replies / proactive alerts. **Slack** does this with the Events API + a per-workspace bot token; **Teams** does it with the Bot Framework Connector + a stored conversation reference and one global bot credential.

## 3. Step 0 — the platform-neutral refactor (its own PR, zero Slack behavior change)

This must ship **first, alone, with no observable change to Slack.** It generalizes the install record and introduces the send abstraction; every existing Slack call site is rerouted through it. The current Slack surface lives almost entirely in `slack/server.mjs`.

### 3a. Generalize the install record — `slack/installations.mjs`
Target shape (from `MULTI_PLATFORM.md`): `{ platform, tenantId, deliver, installedBy, installedAt }`, where for Slack `deliver = botToken`, and for Teams `deliver = { serviceUrl, conversation, bot, user, tenantId }` (the conversation reference). Do this **additively** so the pinned tests stay green:

- `saveInstallation` (`installations.mjs:16–21`): default `platform = 'slack'`, set `deliver = inst.botToken` when absent, accept `inst.tenantId || inst.teamId` for the required-id check. **Keep** the existing `teamId required` error message and keep `botToken` readable (pinned by `installations.test.mjs:9–11,36`).
- Add a `deliverFor(install)` accessor returning `install.deliver ?? install.botToken`, so already-persisted Slack records (which only have `botToken`) still resolve.
- **Namespace, don't rename.** Keep Slack keyed as today: `instKey = slack:inst:<teamId>`, index `slack:teams` (`installations.mjs:9–11`). Add Teams under its own keys — `teams:inst:<tenantId>`, index `teams:tenants` — and a per-platform lookup. `listInstallations()` (used by `/health` at `server.mjs:353`) and `getInstallation(a.watch.team)` (watch ticker, `server.mjs:409`) must keep returning Slack records; make these platform-aware or default to Slack.
- `oauth.mjs:40–47` (`exchangeCode`, Slack-only) additionally stamps `platform:'slack'` and `deliver: j.access_token` so new installs are already in the generalized shape. **Add fields only** — `oauth.test.mjs:34–39` still asserts the six current fields.

### 3b. New `send.mjs` (platform-neutral wire layer)
Three functions, each branching on `install.platform`:
- `send(install, { channelId, threadId, text, blocks })`
- `update(install, { channelId, messageId, text })`
- `dm(install, { userId, text })`

The **Slack branch is literally the current code**: `send` = `slackApi('chat.postMessage', …)` (`server.mjs:88–97, 101–102`), `update` = `chat.update` re-wrapping `text` into the single `section` block (`:103–104`), `dm` = `conversations.open` + `chat.postMessage` (`:105–109`). The **Teams branch** delegates to `teams/connector.mjs` (§4). The bot token (`deliver`) must never be read outside this layer.

### 3c. Reroute every Slack wire call site — `slack/server.mjs`
Replace each `apiFor(...)`/`slackApi(...)` with `send`/`update`/`dm`:
- `:169–172`, `:243–245` — drop `inst?.botToken || BOT_TOKEN` + `apiFor`; resolve `install` and call the abstraction.
- `:218` reply, `:224` approval card, `:228` error, `:178`/`:305` onboarding DM → `send`/`dm`.
- `:248,252,262,266,268` card updates → `update`.
- **`:410–412` watch ticker** — the single most important conversion: `slackApi('chat.postMessage', { channel: a.watch.channel, thread_ts: a.watch.thread, text: a.message }, token)` → `send(install, { channelId: a.watch.channel, threadId: a.watch.thread, text: a.message })`. This is the proactive path that, for Teams, requires the stored conversation reference.
- **Tool send path** (`:64–68` `post_report_to_channel` → `ctx.postMessage`, wired at `:210` and `:264`): pass a `send`-bound closure into the tool context instead of the raw Slack `post`. Rename the neutral context keys to `channelId`/`threadId` (currently `channel`/`thread`).

### 3d. Card builder seam
Move `approvalBlocks` (`server.mjs:140–151`) and `summarizeInput` (`:131–138`) behind a per-adapter card builder. Recommended: a neutral `buildApprovalCard(id, tool, input)` that returns `{ id, tool, input }` (structured), with each adapter rendering it to Block Kit (Slack) or Adaptive Card (Teams). Keep `summarizeInput` neutral by returning `{ key, value }` pairs and letting each adapter format.

### 3e. Inbound normalization seam (same wave)
Extract `normalizeSlackEvent(payload) → { tenantId, channelId, threadId, userId, text }` from the Slack-shaped reads in `handleEvent` (`:155–193`: `payload.event`, `team_id`, `app_mention`/`message.im`, `<@U…>` cleaning at `:122`, bot-loop suppression via `botUserId` at `:184`). The Teams adapter mirrors this with `normalizeTeamsActivity`.

**Untouched in Step 0:** `watches.mjs`, `pending.mjs`, `memory.mjs`, `usage.mjs`, `store.mjs`, `agent.mjs`, `tools/`, `MARCO_PERSONA`.

## 4. The `teams/` adapter — file by file

| File | What it does | Slack analog |
|---|---|---|
| **`teams/server.mjs`** | Raw `node:http` server (or a `/api/messages` route mounted on the existing process) reading one POST. Parses the `Activity`, runs JWT verify, dispatches `message` / `conversationUpdate` / button-`message` (Action.Submit). Acks fast, runs the agent async (mirrors Slack's `void handleEvent`). Normalizes via `normalizeTeamsActivity`. | `slack/server.mjs` HTTP server + `handleEvent`/`handleInteraction` |
| **`teams/verify.mjs`** | Verifies the inbound `Authorization: Bearer <JWT>`: fetch OpenID metadata `https://login.botframework.com/v1/.well-known/openidconfiguration` → `jwks_uri`; verify RS256 against JWKS; check `iss == https://api.botframework.com`, `aud == MS_APP_ID`, expiry with 5-min skew, **and the token's `serviceUrl` claim == the Activity body `serviceUrl`** (hand-written, no lib does this). On failure → HTTP 403. | `slack/verify.mjs` (HMAC) |
| **`teams/connector.mjs`** | Outbound Connector client (from Findings 3): `botToken()` client-credentials fetch (cached, refresh 5 min early), `connectorPost(ref, path, activity)` with 429 backoff + 28 KB truncation. Exposes `teamsSend({ conversationId, replyToId, text, card })` and `teamsUpdate` (HTTP `PUT`). Called by `send.mjs`'s Teams branch. | `slackApi`/`apiFor` (`server.mjs:88–110`) |
| **`teams/normalize.mjs`** | `normalizeTeamsActivity(activity) → { tenantId, channelId, threadId, userId, text }`. `tenantId = channelData.tenant.id`; `channelId = conversation.id`; `threadId = replyToId ?? conversation.id`; `userId = from.aadObjectId`; strips the `<at>…</at>` mention span. Also returns `serviceUrl`, `conversationType`, raw `activity.id`. | `cleanText` + the reads in `handleEvent` |
| **`teams/cards.mjs`** | `approvalCard(id, tool, input)` → Adaptive Card v1.5 with two `Action.Submit` whose `data` is `{ marco:'approve'\|'reject', actionId: id }`; `summaryCard`/text helpers. Renders the neutral `buildApprovalCard` output. | `approvalBlocks` (`server.mjs:140–151`) |
| **`teams/onboarding.mjs`** *(or extend `onboarding.mjs`)* | `onboardingTextTeams(userName)` — reuses the copy but in Teams markdown (no `<@U…>`; use the display name or a Teams `<at>` mention). | `onboardingText` |
| **`teams/manifest.json` + icons** | Teams app package (manifest schema **1.29** + `color.png` 192×192 + `outline.png` 32×32), zipped for sideload/AppSource. | `slack/marco-app-manifest.json` |

The Teams adapter imports the **same** `TOOLS`, `runAgent`, `getHistory`/`appendTurn`, `putPending`/`peekPending`/`takePending`, `evaluateWatches`, `recordUsage` as Slack — only the system prompt's formatting clause differs (Teams markdown instead of Slack mrkdwn; mirror `SLACK_SYSTEM` at `server.mjs:75–76`).

## 5. Auth & delivery

**Inbound (verify-on-receive).** Unlike Slack's hand-rolled HMAC, Teams requires verifying a Microsoft-signed RS256 JWT against a rotating JWKS. Rules (Findings 2): `iss == https://api.botframework.com`; `aud == <MS_APP_ID>`; within validity, 5-min clock skew; signature against a JWKS key (cache, refresh ≤24h); and the **`serviceUrl`-claim-equals-body** check (anti-spoofing, hand-written). Any failure → **403**. (Emulator path is optional, local-testing only — different issuers/metadata; skip for production.)

**Outbound (token-on-send).** One global bot credential, **no per-tenant token**. Mint a service-to-service token: `POST https://login.microsoftonline.com/botframework.com/oauth2/v2.0/token` with `grant_type=client_credentials`, `client_id=MS_APP_ID`, `client_secret=MS_APP_SECRET`, `scope=https://api.botframework.com/.default` → ~3600 s token, **cached bot-wide** and refreshed ~5 min early. The `botframework.com` segment is a literal string (we register single-tenant; see §7). Send/reply/update against the stored `serviceUrl`:
- Reply in thread: `POST {serviceUrl}/v3/conversations/{conversationId}/activities/{activityId}` with `replyToId` set.
- Proactive / new: `POST {serviceUrl}/v3/conversations/{conversationId}/activities`.
- Update card in place (the `chat.update` mirror): **`PUT {serviceUrl}/v3/conversations/{conversationId}/activities/{activityId}`**.

Handle 429 with exponential backoff (respect `Retry-After`), cap activities at 28 KB (truncate/split), log `X-Correlating-OperationId` on errors.

**Conversation-reference capture (= `deliver`).** On the **first** activity from a tenant — and refreshed on **every** subsequent activity — persist `{ serviceUrl, conversation, channelId:'msteams', bot: activity.recipient, user: activity.from, tenantId: channelData.tenant.id }`. `serviceUrl` is regional and rotates: always overwrite with the latest seen before persisting. Proactive watch alerts resume this reference (no create-conversation needed because the watch fired from a conversation we already hold a reference for). Prune a reference on `403` with `subCode: MessageWritesBlocked` (the analogue of Slack `app_uninstalled`/`tokens_revoked`).

**Note (raw-HTTP clarification, Findings 3):** the SDK's `trustServiceUrl` 401 class does **not** exist on our raw path — we attach the `Authorization` header ourselves, so there's nothing to "trust." Real 401s = expired/wrong token, wrong scope, or App ID/secret mismatch.

## 6. Approval flow on Teams (reusing `pending.mjs` unchanged)

The Slack flow maps 1:1; only the card JSON and the inbound shape differ.
1. Agent proposes a dry-run action → `putPending({ tool, input, requestedBy, team:tenantId, channel:conversationId, thread })` (**`pending.mjs` unchanged**), then `send(install, { …, blocks: approvalCard(id, tool, input) })`.
2. The card carries the pending id in each `Action.Submit`'s `data` (`{ marco:'approve'|'reject', actionId: id }`). Object `data` produces an **invisible** message — no chat noise.
3. The click returns a normal `message` activity with the payload under **`activity.value`** (`value.actionId` = Slack's `payload.actions[0].value`; `from.aadObjectId` = Slack's `clicker`) and `replyToId` = the card's message id. Respond within ~5 s.
4. `handleTeamsInteraction`: `peekPending(value.actionId)`; on reject → `takePending` + `update` the card to "❌ Rejected"; on approve → re-gate against the tenant's action allowlist (keyed by `aadObjectId`), `takePending`, run `tool.handler(input, { channelId, threadId, team, postMessage: <send-bound> })`, then **`PUT`-update** the card to "✅ Approved … done." This mirrors `handleInteraction` (`server.mjs:233–270`) exactly.

**Two platform deltas to handle:** Teams has no `response_url` ephemeral — the unauthorized-clicker notice (Slack `postEphemeral`, `server.mjs:258`) becomes a card update or a per-user message. And Teams doesn't support primary/destructive `ActionStyle`, so "Reject" can't be styled red — use the label only.

## 7. Install & onboarding

**Manifest & distribution.** Ship `teams/manifest.json` (schema 1.29) + two PNG icons, mapping from the Slack manifest: `name.short/full`, `description.short(≤80)/full(≤4000)`, `icons.color/outline`, `accentColor`, `bots[0]` with `botId = MS_APP_ID` and `scopes: ["personal","team","groupChat"]`, `isNotificationOnly: false`, `validDomains` including the Railway host (and `token.botframework.com` if needed). Skip `webApplicationInfo` for v1 (no SSO — we key the allowlist off `aadObjectId`, delivered on every activity). Distribution path: **single-tenant bot registration published to AppSource/Teams Store** is the supported cross-tenant route (multi-tenant bot *creation* was deprecated 2025-07-31; single-tenant channel auth works cross-tenant because bot↔Connector auth is separate from user auth). For dev/pilot, sideload the zip or use a customer's Teams Admin Center org catalog.

**Capturing the reference + the magic moment.** When Marco is installed in **personal** scope, Teams immediately sends a `conversationUpdate` with `membersAdded` containing the bot itself (`id` matches `recipient.id`, format `28:<MS_APP_ID>`). Detect bot-self-added, persist the conversation reference as the Teams install record (§5), set `onboarded`, and **reply on that very turn** with the onboarding copy (rendered via the Teams onboarding renderer). This is *cleaner* than Slack: the install event already carries a live `conversation.id` + `serviceUrl` + the installer's `from`/`aadObjectId`, so no separate proactive plumbing is needed for the first hello (Slack fires this from the OAuth callback, `server.mjs:301–306`). Also add the installer's `aadObjectId` to the action allowlist on install (Slack analog: `addActionUser(inst.teamId, inst.installedBy)`, `server.mjs:301`).

**Respond-when logic (mirrors Slack `app_mention` vs `message.im`).** `conversationType === 'personal'` → respond to every message (no mention needed). `channel`/`groupChat` → respond **only** when mentioned: confirm via `entities[]` where `mentioned.id === recipient.id` (never parse the text — it's forgeable). Strip the matching `<at>…</at>` span before passing to the agent. Stay mention-gated (don't opt into RSC) to avoid noise.

## 8. Dependencies & stack impact

**Recommendation: hand-roll the Teams adapter on raw `node:http`; do NOT adopt `botbuilder`.** The entire outbound surface is 4 REST calls + a token fetch — structurally identical to the Slack Web API we already hand-roll. `botbuilder` is a large, opinionated multi-package SDK built around an Express/restify hosting model and `TeamsActivityHandler` subclassing; adopting it would invert "thin adapter over a shared brain" and violate the locked near-zero-dep stack. Cards, manifest, conversation references, send/update — all just JSON we POST.

**The one justified dependency: inbound JWT/JWKS verification.** Hand-rolling RSA signature verification against a *rotating* JWKS in pure `node:crypto` is error-prone and security-critical (a mistake "could divulge the bot's JWT token"). Add exactly two small, focused libs — **`jsonwebtoken`** (verify with `issuer`/`audience`/`clockTolerance`) + **`jwks-rsa`** (kid-keyed JWKS fetch + caching). This is precisely the spot `MULTI_PLATFORM.md` flagged as "where Teams realistically needs a dependency." Everything else — token fetch, send/update, card JSON, manifest, reference capture — stays hand-rolled. Net new deps: **2**, scoped to `teams/verify.mjs`. The `serviceUrl`-claim-equals-body check is still hand-written (no lib does it). Update `MULTI_PLATFORM.md` to record this decision.

## 9. Env vars & deploy

New Teams env (global, **not** per-tenant):
- `MS_APP_ID` — Bot Framework App ID (also the JWT `aud`, the manifest `botId`, the bot channel id prefix `28:`).
- `MS_APP_SECRET` — bot secret (client-credentials password).
- `TEAMS_MESSAGING_PATH` — default `/api/messages` (optional override).

Unchanged/shared: `ANTHROPIC_API_KEY`, `RELAY_URL`, `RELAY_SHARED_SECRET`, Upstash, `WATCH_TICK_MS`.

**Deploy shape.** Two clean options:
- **(Recommended) Same Railway process, mount `/api/messages`** alongside the Slack routes in one HTTP server. Pros: one watch ticker (the existing `tickWatches` already resolves the install per alert and, post-Step-0, `send` branches on platform — so it serves Slack and Teams in one loop), one process to operate, shared in-memory caches (event dedupe, token). This is the natural fit.
- **(Alt) Separate `teams/server.mjs` process / Railway service** if you want isolation of the JWT-verify path or independent scaling. Cost: the watch ticker must run in exactly one place — either keep it Slack-side and have it `send` to Teams installs too (works, since `getInstallation`/`send` are platform-aware after Step 0), or split tickers by platform. Prefer the single-process option unless there's an operational reason to split.

## 10. Phased delivery & testing

Ordered PRs:

1. **PR 1 — Step 0 refactor (no Teams code).** Generalize `installations.mjs` (additive), add `send.mjs`, reroute all `slack/server.mjs` call sites, extract `buildApprovalCard`/`normalizeSlackEvent`. **Zero Slack behavior change.** *Unit (node:test):* keep `installations.test.mjs` + `oauth.test.mjs` green; add tests that `deliverFor` resolves legacy `botToken`-only records, that `send/update/dm` Slack branch produces the same payloads as today (snapshot the `slackApi` args). *Manual:* full Slack regression — mention, DM, propose→approve→update, watch alert, install DM.
2. **PR 2 — Teams receive + verify + echo.** `teams/server.mjs`, `teams/verify.mjs`, `teams/normalize.mjs`; reply "pong"/echo to validate the loop end-to-end. *Unit:* `normalizeTeamsActivity` against the real payloads in the findings (channel message with `<at>` strip; personal message; button `value`); verify rejects bad `iss`/`aud`/expired and serviceUrl-mismatch (mock JWKS). *Manual:* Bot Framework Emulator + a sideloaded app in a real tenant.
3. **PR 3 — Teams send/update + agent wiring.** `teams/connector.mjs` + Teams branch in `send.mjs`; run the real `runAgent` with `TOOLS`; threaded replies. *Unit:* `botToken` cache/refresh; 429 backoff; 28 KB truncation; `teamsSend` path selection (reply vs proactive). *Manual:* @Marco in a channel and DM; verify Italian/English language matching still works.
4. **PR 4 — Approval flow.** `teams/cards.mjs` + interaction handler; reuse `pending.mjs`. *Manual:* propose → Approve/Reject → in-place card update; unauthorized-clicker path.
5. **PR 5 — Install, onboarding, proactive.** `conversationUpdate` capture + first-turn onboarding; route the watch ticker to Teams installs. *Manual:* fresh install → onboarding hello; set a watch → trigger a state change → proactive alert lands; uninstall → reference pruned on `MessageWritesBlocked`.
6. **PR 6 — Manifest + distribution.** `teams/manifest.json` + icons; sideload; then AppSource submission (publisher verification/attestation, descriptions, test accounts).

**Rough effort:** Step 0 ~1 day (mechanical but touches every send site; tests gate it). Teams receive+verify ~1 day (JWT verify is the careful part). Send + agent wiring ~0.5 day. Approval + onboarding + proactive ~1 day. Manifest/sideload ~0.5 day; AppSource review is calendar time, not dev time. **~4 dev-days to a sideloadable, fully-working Teams Marco**, matching the `MULTI_PLATFORM.md` "roughly a day for the adapter" estimate once Step 0 is excluded.

## 11. Open decisions to confirm before building

1. **Same process or separate Railway service** for `/api/messages` (§9). Recommend same process; confirm.
2. **Single-tenant bot registration** is the intended path (no user SSO/Graph in v1). Confirm we don't need to sign users in to call Graph as them — if we ever do, that needs a *second*, multi-tenant app registration.
3. **Accept the 2 npm deps** (`jsonwebtoken` + `jwks-rsa`) for inbound JWT verification, breaking the strict near-zero-dep stance in exactly that one file (§8). Confirm, and confirm we'll record it in `MULTI_PLATFORM.md`.
4. **Bot scopes** — ship all three (`personal`, `team`, `groupChat`)? Recommend yes; `personal` is where the magic-moment DM lands.
5. **Distribution target for v1** — sideload/org-catalog for design partners first, AppSource later? (Affects how soon we start the publisher-verification clock.)
6. **Live-trace claims to validate before GA** (from Findings 2): `from.aadObjectId` is populated for real users; `channelData.tenant.id` is on every production activity; single-tenant channel auth succeeds cross-tenant from Railway; the serviceUrl-claim check actually fires; mention-gating behaves as documented in `channel` scope.

Relevant files: `/Users/brunopais/worldmonitor/assistant/slack/server.mjs`, `/Users/brunopais/worldmonitor/assistant/slack/installations.mjs`, `/Users/brunopais/worldmonitor/assistant/slack/onboarding.mjs`, `/Users/brunopais/worldmonitor/assistant/watches.mjs`, `/Users/brunopais/worldmonitor/assistant/MULTI_PLATFORM.md`, and the new `/Users/brunopais/worldmonitor/assistant/send.mjs` + `/Users/brunopais/worldmonitor/assistant/teams/` tree.