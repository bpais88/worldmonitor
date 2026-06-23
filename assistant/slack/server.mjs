// Slack surface for Marco — the freight-ops AI coworker.
//
// MULTI-WORKSPACE: customers "Add to Slack" via OAuth; each workspace's bot token
// is stored (installations.mjs) and looked up per event by team_id, so one process
// serves every workspace. On install, Marco DMs the installer to introduce himself
// (the onboarding "magic moment").
//
// Per message: @mention/DM -> verify signature -> ack <3s -> run the agent with a
// PER-USER, PER-WORKSPACE policy. Actions are never auto-executed: the agent
// PROPOSES (dry-run) and we post Approve/Reject buttons; execution happens only
// when a workspace-authorized user approves. Per-thread memory enables follow-ups.
// Standalone ESM service — `node assistant/slack/server.mjs`.
//
// Env (multi-tenant): SLACK_CLIENT_ID, SLACK_CLIENT_SECRET, SLACK_SIGNING_SECRET,
//      SLACK_REDIRECT_URI (optional; else derived from request host), PUBLIC_URL.
// Env (legacy single-workspace fallback, still honored if no install record):
//      SLACK_BOT_TOKEN, SLACK_BOT_USER_ID, SLACK_ACTION_USERS.
// Env (shared): ANTHROPIC_API_KEY, RELAY_URL, RELAY_SHARED_SECRET, PORT (3010).
import http from 'node:http';
import { runAgent, DEFAULT_SYSTEM } from '../agent.mjs';
import { freightTools } from '../tools/freight.mjs';
import { actionTools } from '../tools/actions.mjs';
import { weatherTools } from '../tools/weather.mjs';
import { watchTools } from '../tools/watches.mjs';
import { verifySlackSignature } from './verify.mjs';
import { policyForUser, parseActionUsers } from './permissions.mjs';
import { threadKey, getHistory, appendTurn } from './memory.mjs';
import { putPending, peekPending, takePending } from './pending.mjs';
import { relayGet } from '../relay.mjs';
import { listWatches, evaluateWatches } from '../watches.mjs';
import { authorizeUrl, exchangeCode, newState, consumeState } from './oauth.mjs';
import {
  getInstallation, saveInstallation, getConfig, setConfig, addActionUser, listInstallations, removeInstallation,
} from './installations.mjs';
import { MARCO_PERSONA, onboardingText } from './onboarding.mjs';
import { recordUsage } from '../usage.mjs';
import { privacyHtml, supportHtml } from './legal.mjs';

const PORT = process.env.PORT || 3010;
const SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET || '';
// Multi-tenant OAuth credentials.
const CLIENT_ID = process.env.SLACK_CLIENT_ID || '';
const CLIENT_SECRET = process.env.SLACK_CLIENT_SECRET || '';
// Legacy single-workspace fallback (used only when no install record exists).
const BOT_TOKEN = process.env.SLACK_BOT_TOKEN || '';
const BOT_USER_ID = process.env.SLACK_BOT_USER_ID || '';
const ENV_ACTION_USERS = parseActionUsers(process.env.SLACK_ACTION_USERS);

// Slack-only action tool: post a report/message into the CURRENT channel. The
// handler receives the live Slack context (channel/thread + a postMessage fn) at
// execution time. Gated by the same approval flow.
const slackTools = [
  {
    name: 'post_report_to_channel',
    kind: 'action',
    description:
      'Post a report or summary as a message into the current Slack channel so the team sees it. Use when asked to post/share/send/publish a report or summary to the channel. Write the content in Slack mrkdwn.',
    input_schema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'the message/report in Slack mrkdwn' } },
      required: ['text'],
      additionalProperties: false,
    },
    handler: async ({ text }, ctx = {}) => {
      if (!ctx.postMessage || !ctx.channel) return { error: 'no Slack channel context' };
      await ctx.postMessage(ctx.channel, ctx.thread, text);
      return { posted: true, chars: String(text).length };
    },
  },
];

const TOOLS = [...freightTools, ...weatherTools, ...watchTools, ...actionTools, ...slackTools];
const toolByName = new Map(TOOLS.map((t) => [t.name, t]));

// Marco's voice + Slack mrkdwn rules layered on the analyst base prompt.
const SLACK_SYSTEM = `${MARCO_PERSONA}\n\n${DEFAULT_SYSTEM}\n\nYou are replying in Slack. Use Slack mrkdwn: *bold* (single asterisks), _italics_, and "• " bullets. Do NOT use markdown tables or ## headers. Keep replies tight.\n\nWhen an action tool returns {dryRun}, it has been PROPOSED and an Approve/Reject card is shown below your message. Tell the user you've proposed it and to click *Approve* to run it. Do NOT say "actions need to be enabled" — they just need to approve.`;

const seenEvents = new Set(); // dedupe Slack retries by event_id
function alreadySeen(id) {
  if (!id) return false;
  if (seenEvents.has(id)) return true;
  seenEvents.add(id);
  if (seenEvents.size > 1000) seenEvents.delete(seenEvents.values().next().value);
  return false;
}

// ---- Slack Web API helpers (token is per-workspace) -----------------------
async function slackApi(method, payload, botToken) {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: `Bearer ${botToken}` },
    body: JSON.stringify(payload),
  });
  const j = await res.json().catch(() => ({}));
  if (!j.ok) console.warn(`[slack] ${method} failed:`, j.error || res.status);
  return j;
}

// Build token-bound helpers for one workspace.
function apiFor(botToken) {
  const post = (channel, thread_ts, text, blocks) =>
    slackApi('chat.postMessage', { channel, thread_ts, text, blocks, unfurl_links: false }, botToken);
  const update = (channel, ts, text) =>
    slackApi('chat.update', { channel, ts, text, blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }] }, botToken);
  const dm = async (userId, text) => {
    const open = await slackApi('conversations.open', { users: userId }, botToken);
    const channel = open.channel?.id;
    if (channel) await slackApi('chat.postMessage', { channel, text, unfurl_links: false }, botToken);
  };
  return { post, update, dm };
}

async function postEphemeral(responseUrl, text) {
  if (!responseUrl) return;
  await fetch(responseUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ response_type: 'ephemeral', text }),
  }).catch(() => {});
}

const cleanText = (t) => String(t || '').replace(/<@[A-Z0-9]+>/g, '').replace(/\s+/g, ' ').trim();

// Which users may EXECUTE actions in this workspace. Installed workspaces use their
// own config allowlist; a legacy (env-token) workspace falls back to env.
function resolveActionUsers(inst, cfg) {
  return inst ? new Set(cfg.actionUsers || []) : ENV_ACTION_USERS;
}

// Compact, human-readable summary of a proposed action's input.
function summarizeInput(input = {}) {
  return Object.entries(input)
    .map(([k, v]) => {
      const s = typeof v === 'string' ? v : JSON.stringify(v);
      return `*${k}:* ${s.length > 120 ? s.slice(0, 120) + '…' : s}`;
    })
    .join('\n');
}

function approvalBlocks(id, tool, input) {
  return [
    { type: 'section', text: { type: 'mrkdwn', text: `🔧 *Proposed action:* \`${tool}\`\n${summarizeInput(input)}` } },
    {
      type: 'actions',
      elements: [
        { type: 'button', text: { type: 'plain_text', text: 'Approve' }, style: 'primary', action_id: 'approve_action', value: id },
        { type: 'button', text: { type: 'plain_text', text: 'Reject' }, style: 'danger', action_id: 'reject_action', value: id },
      ],
    },
  ];
}

// ---- Event handling -------------------------------------------------------
async function handleEvent(payload) {
  const ev = payload.event;
  if (!ev) return;
  const teamId = payload.team_id || ev.team || payload.team?.id || '';

  // Uninstall / token revocation: drop the workspace so we stop using a dead token.
  // (No token needed to handle this — and it may already be gone.)
  if (ev.type === 'app_uninstalled' || ev.type === 'tokens_revoked') {
    await removeInstallation(teamId);
    console.log(`[slack] ${ev.type}: removed workspace ${teamId}`);
    return;
  }

  const inst = await getInstallation(teamId);
  const botToken = inst?.botToken || BOT_TOKEN;
  const botUserId = inst?.botUserId || BOT_USER_ID;
  if (!botToken) { console.warn(`[slack] no token for team ${teamId}`); return; }
  const { post, dm } = apiFor(botToken);

  // First-run onboarding: greet anyone who opens Marco's home tab once per workspace.
  if (ev.type === 'app_home_opened') {
    const cfg = await getConfig(teamId);
    if (!cfg.onboarded && ev.user && ev.user !== botUserId) {
      await dm(ev.user, onboardingText(ev.user));
      await setConfig(teamId, { onboarded: true });
    }
    return;
  }

  if (ev.bot_id || ev.subtype || (botUserId && ev.user === botUserId)) return;
  const isMention = ev.type === 'app_mention';
  const isDM = ev.type === 'message' && ev.channel_type === 'im';
  if (!isMention && !isDM) return;

  const userText = cleanText(ev.text);
  if (!userText) return;
  const channel = ev.channel;
  const threadTs = ev.thread_ts || ev.ts;
  const key = threadKey(`${teamId}:${channel}`, threadTs);

  const cfg = await getConfig(teamId);
  const actionUsers = resolveActionUsers(inst, cfg);
  // Slack always PROPOSES actions (never auto-executes): allowDryRunForAll lets
  // ANY requester's action become a proposal card, and execute:false ensures even
  // allowlisted users go through the button. Execution is re-gated in handleInteraction.
  const policy = { ...policyForUser(ev.user, { actionUsers, allowDryRunForAll: true }), execute: false };
  console.log(`[slack] msg @${ev.user} in ${teamId}/${channel}: "${userText.slice(0, 100)}"`);

  try {
    const { text, audit, calls, usage } = await runAgent({
      userText,
      history: await getHistory(key),
      tools: TOOLS,
      system: SLACK_SYSTEM,
      policy,
      context: { channel, thread: threadTs, user: ev.user, team: teamId, postMessage: post },
    });
    // Observe-only token metering (no cap yet) — per workspace, per day.
    const day = await recordUsage(teamId, usage);
    const proposed = audit.filter((x) => x.mode === 'dryrun').length;
    console.log(`[slack]   → tools: ${calls.join(', ') || 'none'}${proposed ? ` · ${proposed} proposed` : ''} · ${usage.input}+${usage.output} tok · replied ${text.length} chars` +
      (day ? ` · today ${day.messages} msg / ${day.input + day.output} tok` : ''));
    const reply = text || '(no answer)';
    await post(channel, threadTs, reply);
    await appendTurn(key, userText, reply);

    // For each proposed (dry-run) action, post an Approve/Reject card.
    for (const a of audit.filter((x) => x.mode === 'dryrun')) {
      const id = await putPending({ tool: a.tool, input: a.input, requestedBy: ev.user, team: teamId, channel, thread: threadTs });
      await post(channel, threadTs, `Proposed action: ${a.tool}`, approvalBlocks(id, a.tool, a.input));
    }
  } catch (e) {
    console.error('[slack] agent error:', e.message);
    await post(channel, threadTs, `⚠️ Sorry — I hit an error: ${e.message}`);
  }
}

// ---- Interaction (button) handling ---------------------------------------
async function handleInteraction(payload) {
  const clicker = payload.user?.id;
  const teamId = payload.team?.id || payload.user?.team_id || '';
  const action = payload.actions?.[0] || {};
  const id = action.value;
  console.log(`[slack] button ${action.action_id} by @${clicker} in ${teamId} (${id})`);
  const channel = payload.channel?.id;
  const ts = payload.message?.ts;

  const inst = await getInstallation(teamId);
  const botToken = inst?.botToken || BOT_TOKEN;
  if (!botToken) return;
  const { post, update } = apiFor(botToken);
  const pend = await peekPending(id);

  if (!pend) return update(channel, ts, '⌛ This proposed action expired.');

  if (action.action_id === 'reject_action') {
    await takePending(id);
    return update(channel, ts, `❌ Rejected by <@${clicker}> — \`${pend.tool}\` not run.`);
  }

  // approve — only workspace-authorized users may execute.
  const cfg = await getConfig(teamId);
  if (!resolveActionUsers(inst, cfg).has(clicker)) {
    return postEphemeral(payload.response_url, "You're not authorized to approve actions.");
  }
  await takePending(id);
  const tool = toolByName.get(pend.tool);
  if (!tool) return update(channel, ts, `⚠️ Unknown tool \`${pend.tool}\`.`);
  try {
    const result = await tool.handler(pend.input || {}, { channel: pend.channel, thread: pend.thread, team: teamId, postMessage: post });
    const summary = result && result.error ? `error: ${result.error}` : JSON.stringify(result).slice(0, 200);
    await update(channel, ts, `✅ Approved by <@${clicker}> — \`${pend.tool}\` done.\n${summary}`);
  } catch (e) {
    await update(channel, ts, `⚠️ \`${pend.tool}\` failed: ${e.message}`);
  }
}

// ---- OAuth install flow ("Add to Slack") ----------------------------------
function redirectUri(req) {
  if (process.env.SLACK_REDIRECT_URI) return process.env.SLACK_REDIRECT_URI;
  const host = req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || 'https';
  return `${proto}://${host}/slack/oauth/callback`;
}

function htmlPage(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">` +
    `<title>Marco — freight-ops coworker</title>` +
    `<body style="font-family:system-ui,-apple-system,sans-serif;max-width:560px;margin:12vh auto;padding:0 24px;text-align:center;color:#111">${body}</body>`);
}

async function handleInstall(req, res) {
  if (!CLIENT_ID) return htmlPage(res, 500, '<h1>Marco</h1><p>Install not configured (missing SLACK_CLIENT_ID).</p>');
  const url = authorizeUrl({ clientId: CLIENT_ID, redirectUri: redirectUri(req), state: await newState() });
  res.writeHead(302, { Location: url });
  res.end();
}

async function handleOAuthCallback(req, res, query) {
  const { code, state, error } = query;
  if (error) return htmlPage(res, 400, `<h1>Install cancelled</h1><p>${error}</p>`);
  if (!code || !(await consumeState(state))) return htmlPage(res, 400, '<h1>Install failed</h1><p>Invalid or expired request. Please try again.</p>');
  try {
    const inst = await exchangeCode({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, code, redirectUri: redirectUri(req) });
    await saveInstallation(inst);
    if (inst.installedBy) await addActionUser(inst.teamId, inst.installedBy); // installer can approve actions
    // The magic moment: Marco DMs the installer to introduce himself.
    if (inst.installedBy) {
      const { dm } = apiFor(inst.botToken);
      await dm(inst.installedBy, onboardingText(inst.installedBy));
      await setConfig(inst.teamId, { onboarded: true });
    }
    console.log(`[slack] installed in ${inst.teamId} (${inst.teamName}) by ${inst.installedBy}`);
    return htmlPage(res, 200, `<h1>✅ Marco is in <b>${inst.teamName || 'your workspace'}</b></h1><p>Check your Slack DMs — he just said ciao. You can also <b>@Marco</b> in any channel.</p>`);
  } catch (e) {
    console.error('[slack] oauth error:', e.message);
    return htmlPage(res, 500, `<h1>Install failed</h1><p>${e.message}</p>`);
  }
}

function landingPage(res) {
  if (!CLIENT_ID) { // legacy/no-OAuth: keep the JSON health shape at /
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true }));
  }
  htmlPage(res, 200,
    '<h1>Marco</h1><p style="font-size:18px;color:#444">Your freight-ops coworker, in Slack. He tracks every cargo ship and RoPax ferry across Italian ports — live — and tells you when a port congests or clears.</p>' +
    '<p style="margin-top:32px"><a href="/slack/install">' +
    '<img alt="Add to Slack" height="48" width="172" src="https://platform.slack-edge.com/img/add_to_slack.png" srcset="https://platform.slack-edge.com/img/add_to_slack.png 1x, https://platform.slack-edge.com/img/add_to_slack@2x.png 2x"></a></p>');
}

// ---- HTTP server ----------------------------------------------------------
function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 2e6) req.destroy(); });
    req.on('end', () => resolve(data));
  });
}

function verified(req, body) {
  return verifySlackSignature({
    signingSecret: SIGNING_SECRET,
    signature: req.headers['x-slack-signature'],
    timestamp: req.headers['x-slack-request-timestamp'],
    body,
  });
}

const server = http.createServer(async (req, res) => {
  const u = new globalThis.URL(req.url, 'http://localhost');
  const path = u.pathname;

  // --- Unsigned GET routes (browser redirects + health/landing) ---
  if (req.method === 'GET') {
    if (path === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      const teams = await listInstallations().catch(() => []);
      return res.end(JSON.stringify({ ok: true, multiTenant: !!CLIENT_ID, installs: teams.length }));
    }
    if (path === '/slack/install') return handleInstall(req, res);
    if (path === '/slack/oauth/callback') return handleOAuthCallback(req, res, Object.fromEntries(u.searchParams));
    // Public legal pages required for Slack distribution.
    if (path === '/privacy') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(privacyHtml()); }
    if (path === '/support') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(supportHtml()); }
    if (path === '/') return landingPage(res);
    res.writeHead(404); return res.end();
  }
  if (req.method !== 'POST') { res.writeHead(404); return res.end(); }

  // --- Signed POST routes (Slack events + interactions) ---
  const body = await readBody(req);
  if (!verified(req, body)) { res.writeHead(401); return res.end('bad signature'); }

  if (path.startsWith('/slack/events')) {
    let payload;
    try { payload = JSON.parse(body); } catch { res.writeHead(400); return res.end(); }
    if (payload.type === 'url_verification') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ challenge: payload.challenge }));
    }
    res.writeHead(200); res.end(); // ack fast
    if (payload.type === 'event_callback' && !alreadySeen(payload.event_id)) void handleEvent(payload);
    return;
  }

  if (path.startsWith('/slack/interactions')) {
    res.writeHead(200); res.end(); // ack fast
    try {
      const payload = JSON.parse(new URLSearchParams(body).get('payload'));
      if (payload.type === 'block_actions') void handleInteraction(payload);
    } catch (e) { console.error('[slack] interaction parse error:', e.message); }
    return;
  }

  res.writeHead(404); res.end();
});

// ---- Proactive watch ticker ----------------------------------------------
// Every tick: evaluate active watches against live ports/vessels and post to each
// watch's channel ONLY on a state change. Each watch posts with its own workspace's
// token (resolved by watch.team). Skips entirely when there are no watches.
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
      const token = inst?.botToken || BOT_TOKEN;
      if (!token) continue;
      await slackApi('chat.postMessage', { channel: a.watch.channel, thread_ts: a.watch.thread, text: a.message, unfurl_links: false }, token);
    }
    if (alerts.length) console.log(`[slack] watch tick: ${alerts.length} alert(s) posted`);
  } catch (e) {
    console.warn('[slack] watch tick error:', e.message);
  }
}

server.listen(PORT, () => {
  const mode = CLIENT_ID ? 'multi-workspace (OAuth)' : 'single-workspace (env token)';
  console.log(`[slack] Marco on :${PORT} · ${mode}` +
    `${SIGNING_SECRET ? '' : ' · WARN no SLACK_SIGNING_SECRET'}` +
    `${CLIENT_ID || BOT_TOKEN ? '' : ' · WARN no token/client configured'}`);
  setInterval(() => { void tickWatches(); }, WATCH_TICK_MS).unref?.();
  console.log(`[slack] watch ticker every ${WATCH_TICK_MS / 1000}s`);
});
