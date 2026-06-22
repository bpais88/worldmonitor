# Italy Freight Assistant (interactive agent)

A Viktor-style conversational agent: ask it about Italian freight traffic and it
answers from live data by calling tools. The agent loop is **tool-agnostic** —
you extend it by registering tools, never by editing the loop.

## Run (CLI — no Slack needed)

```bash
RELAY_URL=https://<relay-host> \
RELAY_SHARED_SECRET=<secret> \
ANTHROPIC_API_KEY=<key> \
  node assistant/cli.mjs "which ports are congested?"
```

Try: *"what's delayed and why?"*, *"any MSC ships near Genoa?"*, *"give me a freight status report for the Adriatic."*

## Architecture

```
user text ─► runAgent(tools) ─► Claude picks tool(s) ─► handler() ─► result ─► … ─► answer
```

- `agent.mjs` — generic Claude tool-use loop. **Never changes when you add tools.**
- `tools/freight.mjs` — the first tools (ports, vessels, delays), wrapping the relay.
- `relay.mjs` / `config.mjs` — authenticated relay GET + env config.
- `cli.mjs` — local harness.
- `guardrails.mjs` — read/action classification + policy (blocked → dry-run → execute).
- `tools/actions.mjs` — action tools (save report, Slack alert), gated by guardrails.
- `slack/` — the Slack surface (events server, signature verify, per-user permissions, per-thread memory, approval buttons).

## Guardrails (read vs act)

Every tool is `read` (auto-runs) or `action` (gated). Policy escalation:
`default = blocked` → `--allow-actions = dry-run` → `--allow-actions --execute = run`
(capped by `maxActions`, audited). From Slack, actions are **always proposed**, never auto-run (see below).

## Slack surface + per-user approval

`node assistant/slack/server.mjs` runs a service that: verifies Slack's request
signature, @mention/DM → runs the agent → replies in-thread (with per-thread
memory for follow-ups). **Actions require human approval:** the agent proposes an
action, the bot posts *Approve / Reject* buttons, and the tool runs only when a
**allowlisted** user approves (Viktor-style per-action human-in-the-loop).

### Slack app setup

1. api.slack.com/apps → Create App (from scratch) → pick workspace.
2. **OAuth & Permissions** → Bot scopes: `app_mentions:read`, `chat:write`, `im:history`, `im:read`. Install → copy the **Bot User OAuth Token** (`xoxb-…`).
3. **Basic Information** → copy the **Signing Secret**.
4. **Event Subscriptions** → on; Request URL `https://<host>/slack/events`; subscribe to `app_mention` + `message.im`.
5. **Interactivity & Shortcuts** → on; Request URL `https://<host>/slack/interactions` (the Approve/Reject buttons).
6. Invite the bot to a channel; @mention it.

### Env

- `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`
- `SLACK_ACTION_USERS` — comma-separated Slack user ids allowed to approve/run actions
- `SLACK_BOT_USER_ID` (optional, to ignore the bot's own messages)
- `ANTHROPIC_API_KEY`, `RELAY_URL`, `RELAY_SHARED_SECRET`, `PORT` (default 3010)

Needs a public URL — deploy the service (e.g. a second Railway service) or tunnel
(`ngrok http 3010`) for local testing.

## Add a tool (the whole point)

```js
// tools/weather.mjs
export const weatherTools = [{
  name: 'get_port_weather',
  description: 'Marine weather (wind, sea state) at a port. Use for "weather at Genoa".',
  input_schema: { type: 'object', properties: { port: { type: 'string' } }, required: ['port'] },
  handler: async ({ port }) => { /* fetch + return JSON */ },
}];
```

Then pass it in: `runAgent({ userText, tools: [...freightTools, ...weatherTools] })`.
That's it — Claude sees the new capability automatically. Tomorrow's tools
(Stripe, Notion, a database, anything) plug in the same way.

## Required env

- `ANTHROPIC_API_KEY` — the agent's model (Sonnet 4.6 by default; set `ASSISTANT_MODEL` to override).
- `RELAY_URL` + `RELAY_SHARED_SECRET` — to reach the freight data.
