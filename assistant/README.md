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
- *(next)* `slack.mjs` — Slack app: @mention → runAgent → reply in thread.

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
