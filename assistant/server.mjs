// Neutral HTTP host for Marco — owns the listener and request dispatch, mounting the
// Slack and Teams adapters as PEERS (one brain, two thin adapters; see MULTI_PLATFORM.md).
// Neither adapter owns the server: this file reads the body once, routes GET to the
// Slack handlers, routes POST /api/messages to Teams (its own JWT auth), and routes the
// remaining POSTs to the Slack handlers (HMAC-verified inside). It also runs the
// proactive watch ticker, whose delivery is platform-neutral via send().
//
// Entry point: `node assistant/server.mjs`.
// Env: PORT (3010), TEAMS_MESSAGING_PATH (/api/messages), WATCH_TICK_MS. Per-adapter
// env is documented in slack/adapter.mjs and teams/router.mjs.
import http from 'node:http';
import { handleSlackGet, handleSlackPost, slackBoot } from './slack/adapter.mjs';
import { handleTeamsRequest } from './teams/router.mjs';
import { relayGet } from './relay.mjs';
import { listWatches, evaluateWatches } from './watches.mjs';
import { getInstallation, legacyInstall, deliverFor } from './slack/installations.mjs';
import { send } from './send.mjs';

const PORT = process.env.PORT || 3010;
const TEAMS_MESSAGING_PATH = process.env.TEAMS_MESSAGING_PATH || '/api/messages';

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 2e6) req.destroy(); });
    req.on('end', () => resolve(data));
  });
}

const server = http.createServer(async (req, res) => {
  const u = new globalThis.URL(req.url, 'http://localhost');

  // GET routes are all Slack/distribution concerns (health, OAuth, legal pages, landing).
  if (req.method === 'GET') return handleSlackGet(req, res, u);
  if (req.method !== 'POST') { res.writeHead(404); return res.end(); }

  const body = await readBody(req);
  // Teams (Bot Framework) carries its own JWT auth, not Slack's HMAC, so it's dispatched
  // before the Slack signature gate inside handleSlackPost.
  if (u.pathname === TEAMS_MESSAGING_PATH) return handleTeamsRequest(req, res, body);
  return handleSlackPost(req, res, body, u);
});

// ---- Proactive watch ticker ----------------------------------------------
// Every tick: evaluate active watches against live domain data and deliver alerts to
// each watch's channel ONLY on a state change, via the platform-neutral send() (so each
// alert reaches its workspace's platform). The data fetch is freight-domain today; the
// delivery is platform-agnostic. Skips entirely when there are no watches.
const WATCH_TICK_MS = Number(process.env.WATCH_TICK_MS) || 5 * 60_000;
async function tickWatches() {
  try {
    const watches = await listWatches();
    if (!watches.length) return;
    const [portsRes, vesselsRes] = await Promise.all([
      relayGet('/ais/ports'),
      relayGet('/ais/vessels?types=cargo,passenger&freight=1&limit=3000'),
    ]);
    const alerts = await evaluateWatches({ ports: portsRes.ports || [], vessels: vesselsRes.vessels || [] });
    for (const a of alerts) {
      const inst = await getInstallation(a.watch.team);
      const install = inst || legacyInstall();
      if (!deliverFor(install)) continue;
      await send(install, { channelId: a.watch.channel, threadId: a.watch.thread, text: a.message });
    }
    if (alerts.length) console.log(`[host] watch tick: ${alerts.length} alert(s) posted`);
  } catch (e) {
    console.warn('[host] watch tick error:', e.message);
  }
}

server.listen(PORT, () => {
  console.log(`[host] Marco on :${PORT}`);
  slackBoot();
  setInterval(() => { void tickWatches(); }, WATCH_TICK_MS).unref?.();
  console.log(`[host] watch ticker every ${WATCH_TICK_MS / 1000}s`);
  if (process.env.MS_APP_ID) console.log(`[teams] Bot Framework endpoint on ${TEAMS_MESSAGING_PATH}`);
});
