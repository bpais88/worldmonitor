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
import { handleSlackGet, handleSlackPost, slackBoot, slackStatus } from './slack/adapter.mjs';
import { handleTeamsRequest } from './teams/router.mjs';
import { handleVoiceRequest } from './voice/adapter.mjs';
import { handleWhatsAppRequest } from './whatsapp/router.mjs';
import { handleTelegramRequest } from './telegram/router.mjs';
import { relayGet } from './relay.mjs';
import { listWatches, evaluateWatches, evaluateDisruptionWatches } from './watches.mjs';
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

  if (req.method === 'GET') {
    // /health is a host liveness concern; the Slack adapter contributes its sub-status.
    if (u.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, ...(await slackStatus()) }));
    }
    // The remaining GETs (OAuth, served legal pages, landing) are Slack/distribution concerns.
    return handleSlackGet(req, res, u);
  }
  if (req.method !== 'POST') { res.writeHead(404); return res.end(); }

  const body = await readBody(req);
  // Teams (Bot Framework) carries its own JWT auth, not Slack's HMAC, so it's dispatched
  // before the Slack signature gate inside handleSlackPost.
  if (u.pathname === TEAMS_MESSAGING_PATH) return handleTeamsRequest(req, res, body);
  // Voice (ElevenLabs server tools) carries its own shared-secret auth, verified inside.
  if (u.pathname.startsWith('/voice/')) return handleVoiceRequest(req, res, body, u);
  // WhatsApp (Twilio) carries its own `?k=` webhook secret in the URL, verified inside.
  if (u.pathname.startsWith('/whatsapp')) return handleWhatsAppRequest(req, res, body, u);
  // Telegram (Bot API) carries its own X-Telegram-Bot-Api-Secret-Token header, verified inside.
  if (u.pathname.startsWith('/telegram')) return handleTelegramRequest(req, res, body);
  return handleSlackPost(req, res, body, u);
});

// ---- Proactive watch ticker ----------------------------------------------
// Every tick: evaluate active watches against live domain data and deliver alerts to
// each watch's channel ONLY on a state change, via the platform-neutral send() (so each
// alert reaches its workspace's platform). The data fetch is freight-domain today; the
// delivery is platform-agnostic. Skips entirely when there are no watches.
// TODO: the freight fetch+shape belongs in a domain watch-source module; the host should
// only START the loop. Extract when a second watch source or the Teams adapter arrives.
const WATCH_TICK_MS = Number(process.env.WATCH_TICK_MS) || 5 * 60_000;
async function tickWatches() {
  try {
    const watches = await listWatches();
    if (!watches.length) return;
    // Fetch in parallel but fail INDEPENDENTLY: ports is required by every watch type (no ports →
    // outer catch), but the heavier vessels endpoint only feeds the transition watches — a
    // transient vessels 5xx must not starve the scheduled-strike alerts (which need only
    // ports + /ais/disruptions), and vice versa.
    const [portsR, vesselsR] = await Promise.allSettled([
      relayGet('/ais/ports'),
      relayGet('/ais/vessels?types=cargo,passenger&freight=1&limit=3000'),
    ]);
    if (portsR.status === 'rejected') throw portsR.reason;
    const ports = portsR.value.ports || [];
    const alerts = [];
    if (vesselsR.status === 'fulfilled') {
      alerts.push(...await evaluateWatches({ ports, vessels: vesselsR.value.vessels || [] }));
    } else {
      // Skip (don't run with vessels: [] — a one-tick outage must not read as "vessel back on time").
      console.warn('[host] watch tick: vessel fetch failed — transition watches skipped this tick:', vesselsR.reason?.message);
    }
    // M4: one-shot scheduled-strike alerts for watched ports (official calendar only; relay's
    // /ais/disruptions?port= applies the 7-day lookahead + area matching). Own try — a disruption
    // failure must not drop already-collected transition alerts either.
    try {
      alerts.push(...await evaluateDisruptionWatches({
        ports,
        fetchPortDisruptions: (portId) => relayGet(`/ais/disruptions?port=${encodeURIComponent(portId)}`).then((j) => j.events || []),
      }));
    } catch (e) {
      console.warn('[host] watch tick: disruption evaluation failed:', e.message);
    }
    for (const a of alerts) {
      let install, threadId;
      if (a.watch.platform === 'teams') {
        // Teams carries its conversation reference on the watch (no per-tenant token to resolve).
        // Post a fresh message — no replyToId, since the inbound activity is long gone.
        if (!a.watch.deliver?.serviceUrl) continue;
        install = { platform: 'teams', deliver: a.watch.deliver };
        threadId = undefined;
      } else if (a.watch.platform === 'whatsapp' || a.watch.platform === 'telegram') {
        // Plain-chat channels also carry their routing on the watch ({to} / {chatId}, captured at
        // creation). Telegram sends plain; WhatsApp proactive must ride the approved content
        // template — outside the 24h session window Twilio delivers nothing else.
        if (!a.watch.deliver) continue;
        install = { platform: a.watch.platform, deliver: a.watch.deliver };
        threadId = undefined;
      } else {
        install = (await getInstallation(a.watch.team)) || legacyInstall();
        if (!deliverFor(install)) continue;
        threadId = a.watch.thread;
      }
      const template = a.watch.platform === 'whatsapp'
        ? { variables: { 1: a.watch.target, 2: a.message } } // connector sanitizes multi-line prose
        : undefined;
      await send(install, { channelId: a.watch.channel, threadId, text: a.message, template });
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
