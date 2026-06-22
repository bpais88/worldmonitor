# Slack app setup — Italy Freight Assistant

Goal: a Slack bot you @mention that answers freight questions and proposes
actions you approve with a button. ~10 minutes.

Order matters: do **Part A** first and send me the two secrets — I deploy the
service and give you the public URL — then we do **Part B** (the Request URLs)
together.

---

## Part A — create the app + get the secrets (you do this)

1. Go to **https://api.slack.com/apps** → **Create New App** → **From scratch**.
2. Name it **Italy Freight Assistant**, pick your workspace → **Create App**.

3. **OAuth & Permissions** (left sidebar) → scroll to **Scopes → Bot Token Scopes** → **Add an OAuth Scope** for each:
   - `app_mentions:read`  (see @mentions)
   - `chat:write`         (post replies + approval buttons)
   - `im:history`         (read DMs sent to it)
   - `im:read`            (receive DMs)

4. Scroll up on the same page → **Install to Workspace** → **Allow**.
   - Copy the **Bot User OAuth Token** — starts with `xoxb-…`  ✅ *(secret #1)*

5. **Basic Information** (left sidebar) → **App Credentials** →
   - Copy the **Signing Secret** ✅ *(secret #2)*

6. Get **your Slack user ID** (for the action allowlist — only allowlisted users
   can approve actions): in Slack, click your profile → **⋯ (More)** →
   **Copy member ID** (looks like `U0123ABCD`). ✅ *(id #3)*

### Send me these three (without pasting in chat)
Run in your terminal:
```
! printf 'xoxb-...' > /Users/brunopais/worldmonitor/.slack-bot-token
! printf 'your-signing-secret' > /Users/brunopais/worldmonitor/.slack-signing-secret
```
…and just tell me your **member ID** (it's not sensitive). I'll set them as
Railway variables and deploy.

---

## Part B — connect Slack to the service (after I deploy)

I'll give you the service URL, e.g. `https://italy-freight-assistant.up.railway.app`.

7. **Event Subscriptions** → toggle **On** →
   - **Request URL:** `https://<service-url>/slack/events`
     (Slack sends a test — it should show **Verified** ✓)
   - **Subscribe to bot events** → add `app_mention` and `message.im` → **Save Changes**.

8. **Interactivity & Shortcuts** → toggle **On** →
   - **Request URL:** `https://<service-url>/slack/interactions`  → **Save Changes**.
   (This is what powers the Approve/Reject buttons.)

9. Reinstall if Slack prompts (scope/event changes sometimes require it).

10. In Slack: invite the bot to a channel (`/invite @Italy Freight Assistant`)
    and **@mention it**: *"@Italy Freight Assistant what's delayed right now?"*

---

## Try it
- *"@bot which ports are congested?"* → it answers in-thread.
- *"@bot save a congestion report"* → it proposes the action with **Approve / Reject**;
  only allowlisted users (your member ID) can approve.

## Notes
- Non-allowlisted users get **read-only** answers (no action buttons fire for them).
- The bot only sees channels it's invited to, threads it's mentioned in, and DMs.
