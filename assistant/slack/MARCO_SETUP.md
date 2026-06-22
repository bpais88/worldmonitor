# Marco — multi-workspace ("Add to Slack") setup

Marco is now a **distributable** Slack app: any workspace can install him via OAuth,
each gets its own bot token (stored in Upstash, keyed by `team_id`), and on install
Marco DMs the installer to introduce himself. One Railway process serves every
workspace.

Your existing single-workspace install keeps working unchanged — if a workspace has
no OAuth install record, the server falls back to the legacy `SLACK_BOT_TOKEN`.

---

## 1. Slack app config (api.slack.com/apps → your app)

**OAuth & Permissions**
- **Redirect URLs** → add:
  `https://italy-freight-assistant-production.up.railway.app/slack/oauth/callback`
- **Bot Token Scopes** (must match `SCOPES` in `oauth.mjs`):
  `app_mentions:read`, `chat:write`, `im:history`, `im:write`, `users:read`, `team:read`

**Event Subscriptions**
- Request URL: `https://italy-freight-assistant-production.up.railway.app/slack/events`
- Subscribe to **bot events**: `app_mention`, `message.im`, `app_home_opened`

**Interactivity & Shortcuts**
- Request URL: `https://italy-freight-assistant-production.up.railway.app/slack/interactions`

**App Home**
- Enable the **Home Tab** (so `app_home_opened` fires → triggers onboarding for anyone
  who opens Marco who hasn't been greeted yet).

**Basic Information → Display**
- Set the app name to **Marco**, add an avatar + the short description
  ("Your freight-ops coworker — live Italian-port freight tracking, in Slack").

**Manage Distribution**
- Tick "Remove Hard Coded Information" checklist, then **Activate Public Distribution**.
- This gives you the public **"Add to Slack"** link (we also serve our own landing
  page at `/` and the redirect at `/slack/install`).

> App Directory *listing* is optional and comes later (Slack review). You can onboard
> your first customers immediately with the direct install link below.

---

## 2. Railway env vars (italy-freight-assistant service)

Add:
- `SLACK_CLIENT_ID` — Basic Information → App Credentials → Client ID
- `SLACK_CLIENT_SECRET` — App Credentials → Client Secret
- `SLACK_SIGNING_SECRET` — App Credentials → Signing Secret (already set)
- `SLACK_REDIRECT_URI` *(optional)* — only if you don't want it derived from the
  request host; set to the exact callback URL above.

Already set (keep):
- `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` — **required** for per-workspace
  tokens to persist across restarts (without them, installs live in memory and are
  lost on redeploy).
- `ANTHROPIC_API_KEY`, `RELAY_URL`, `RELAY_SHARED_SECRET`, `WATCH_TICK_MS`.

Legacy (can stay as a fallback for your own workspace, or remove once you re-install
via OAuth): `SLACK_BOT_TOKEN`, `SLACK_BOT_USER_ID`, `SLACK_ACTION_USERS`.

---

## 3. Onboard a customer

1. Send them the install link:
   `https://italy-freight-assistant-production.up.railway.app/` (landing page with the
   "Add to Slack" button) — or `/slack/install` directly.
2. They click **Add to Slack** → Slack consent → done.
3. Marco DMs them: *"Ciao, I'm Marco…"* and asks which ports/operators to watch.
4. The installer is automatically added to that workspace's **action allowlist** (can
   approve actions). Add teammates later via config.

---

## 4. How permissions work per workspace

- Anyone can talk to Marco and get answers (read-only).
- Actions (e.g. `post_report_to_channel`) are always **proposed** with Approve/Reject
  buttons; only users in that workspace's `actionUsers` list may approve.
- The installer starts on the list; extend per-workspace config in `installations.mjs`
  (`addActionUser(teamId, userId)`).

---

## 5. Health

`GET /health` → `{ "ok": true, "multiTenant": true, "installs": <n> }`
