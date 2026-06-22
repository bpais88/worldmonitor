# Marco across chat platforms (Slack today, Microsoft Teams later)

Design note for extending Marco — the freight-ops AI coworker — beyond Slack. Read
this before starting the Teams adapter. Nothing here is built yet except the
platform-neutral core and the Slack adapter.

## The principle: one brain, thin per-platform adapters

Everything that makes Marco *Marco* is platform-neutral and already keyed by an
opaque tenant id. Only message I/O is platform-specific.

```
PLATFORM-NEUTRAL CORE (reuse as-is)
  agent.mjs        — Claude tool-use loop ("the brain")
  tools/           — freight, weather, watches, actions
  guardrails.mjs   — read/action classification, blocked→dry-run→execute
  watches.mjs      — proactive alerts (keyed by tenant + channel)
  usage.mjs        — per-tenant token metering
  store.mjs        — Upstash KV (tenant-keyed)
  slack/memory.mjs — per-thread history (keyed by tenant:channel:thread)
        ▲                                   ▲
   slack/ adapter                      teams/ adapter  (to build)
   Events API + per-workspace token    Bot Framework + conversation reference
```

An adapter does exactly three things:
1. **Receive** platform events and normalize to a common shape:
   `{ tenantId, channelId, threadId, userId, text }`
2. **Run** the shared agent with that context (`runAgent({ ..., context })`).
3. **Send** replies / proactive alerts back on that platform.

Everything below the adapter line is reused unchanged.

## Identifier mapping

| Concept            | Slack                 | Microsoft Teams                  |
|--------------------|-----------------------|----------------------------------|
| Tenant / account   | `team_id` (workspace) | **Azure AD `tenantId`** (GUID)   |
| Channel / chat     | `channel`             | `conversation.id`                |
| Thread             | `thread_ts`           | conversation / `replyToId`       |
| User (allowlist)   | `user` (`U…`)         | `aadObjectId`                    |
| Bot identity       | `bot_user_id`         | Bot Framework App ID             |

The tenant key generalizes cleanly: **`tenantId` is "the account"**, exactly like
`team_id`. Treat all of these as opaque strings — the core already does.

## The one real difference: auth & delivery

This is the part that does **not** map 1:1 and is the whole reason the install
record must be generalized.

- **Slack:** each workspace hands you its **own bot token** at OAuth install. You
  store it (`slack:inst:<team_id>.botToken`) and post with it.
- **Teams:** there is **no per-tenant token**. The bot has a single app credential
  (Bot Framework App ID + secret/cert). To reach a tenant you store a
  **conversation reference** (`serviceUrl` + conversation + tenant id), captured the
  first time they interact. Proactive messages (our watch alerts) are sent by
  resuming that reference, not by using a stored token.

Same *shape* ("how do I reach this tenant"), different *contents*.

## Concrete refactor when Teams lands

Today `installations.mjs` stores a Slack-specific `botToken`. Generalize the record:

```js
// instead of { teamId, botToken, botUserId, ... }
{
  platform: 'slack' | 'teams',
  tenantId,                 // team_id (Slack) | aad tenantId (Teams)
  deliver: <token | conversationRef>,  // bot token | { serviceUrl, conversation }
  installedBy,
  installedAt,
}
```

Then add a single `send(install, { channelId, threadId, text, blocks })` that
branches on `install.platform`:
- Slack → `chat.postMessage` with `deliver` as the bearer token (current code).
- Teams → Bot Framework `continueConversation(deliver)` then `sendActivity`.

The watch ticker and approval flow call `send()` instead of `slackApi` directly.
That is the bulk of the adapter — roughly a day, **not a rewrite**, because the
agent, tools, guardrails, watches, usage, and memory don't change.

## Notes & gotchas for the Teams build

- **No native OAuth-per-tenant token** → don't model Teams like Slack. The "install"
  is the Teams app being added (manifest via Teams Admin Center / AppSource /
  sideload); capture the conversation reference on the first activity.
- **`serviceUrl` is regional and can change** — always store the latest one seen and
  use it for proactive sends; don't hardcode.
- **Proactive messaging** (watch alerts) requires the stored conversation reference;
  there's no "post to channel by id" without it.
- **Adaptive Cards** replace Slack Block Kit for the Approve/Reject buttons — same
  pending-action flow (`pending.mjs`), different card JSON in the adapter.
- **Build natively, not via "Bot Framework for both."** The unified path exists but
  its Slack support is weaker than a native Slack app. Two thin adapters over one
  shared core is the pragmatic route.
- **Mentions/DMs:** Teams delivers `message` activities with `conversationType`
  (`personal` vs `channel`); the adapter decides when to respond, mirroring how the
  Slack adapter handles `app_mention` vs `message.im`.

## Status

- ✅ Platform-neutral core — done (agent, tools, guardrails, watches, usage, store).
- ✅ Slack adapter — done (`slack/`), multi-workspace via OAuth.
- ⬜ Generalize the install record (`platform` + `deliver`) — do as the first step of
  the Teams work.
- ⬜ Teams adapter (`teams/`) — Bot Framework receive + conversation-reference send +
  Adaptive Cards.
