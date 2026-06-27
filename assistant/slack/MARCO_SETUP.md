# Marco — multi-workspace ("Add to Slack") setup

Marco is now a **distributable** Slack app: any workspace can install him via OAuth,
each gets its own bot token (stored in Upstash, keyed by `team_id`), and on install
Marco DMs the installer to introduce himself. One Railway process serves every
workspace.

Your existing single-workspace install keeps working unchanged — if a workspace has
no OAuth install record, the server falls back to the legacy `SLACK_BOT_TOKEN`.

---

## 1. Slack app config (api.slack.com/apps)

**Fastest path — create from the manifest.** At api.slack.com/apps → **Create New App**
→ **From a manifest** → pick the workspace → paste the contents of
[`marco-app-manifest.json`](./marco-app-manifest.json). That sets the name,
description, bot user, App Home tab, all bot scopes, the OAuth redirect URL, the
event subscriptions (incl. `app_uninstalled` / `tokens_revoked`), and interactivity —
in one step. (For an existing app, **App Manifest** in the sidebar lets you paste the
same JSON to update it.)

If you prefer to click through instead, the manifest encodes exactly:

- **OAuth redirect URL:** `…/slack/oauth/callback`
- **Bot scopes:** `app_mentions:read`, `chat:write`, `im:history`, `im:write`, `users:read`, `team:read`
- **Event request URL:** `…/slack/events` · **bot events:** `app_mention`, `message.im`, `app_home_opened`, `app_uninstalled`, `tokens_revoked`
- **Interactivity request URL:** `…/slack/interactions`
- **App Home:** Home tab enabled

> ⚠️ When you paste the events request URL, Slack sends a verification challenge — the
> service must already be deployed (it is) so it can answer. The manifest flow handles
> this automatically once the service is up.

**Basic Information → Display:** add an avatar (the name/description come from the manifest).

**Manage Distribution** (these are NOT in the manifest — set them in the UI):

- **Privacy Policy URL:** `https://italy-freight-assistant-production.up.railway.app/privacy`
- **Support URL:** `https://italy-freight-assistant-production.up.railway.app/support`
  (both served live by the assistant — see `legal.mjs`)
- Tick "Remove Hard Coded Information", then **Activate Public Distribution** → gives
  you the public **"Add to Slack"** link (we also serve a landing page at `/`).

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
- `WATCH_DWELL_MS` *(optional)* — how long a watch's state change must hold before
  it alerts (debounce; default 30 min). Stops a port whose congestion flaps near a
  threshold from spamming the channel; a genuinely sustained change still alerts.

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
