// Slack surface for the Italy Freight assistant.
//
// @mention/DM -> verify signature -> ack <3s -> run agent with a PER-USER policy.
// Actions are never auto-executed from Slack: the agent PROPOSES them (dry-run)
// and we post Approve/Reject buttons; execution happens only when an authorized
// user approves (per-action human-in-the-loop, Viktor-style). Per-thread memory
// enables follow-ups. Standalone ESM service — `node assistant/slack/server.mjs`.
//
// Env: SLACK_BOT_TOKEN, SLACK_SIGNING_SECRET, SLACK_ACTION_USERS (allowlist),
//      SLACK_BOT_USER_ID (optional), ANTHROPIC_API_KEY, RELAY_URL,
//      RELAY_SHARED_SECRET, PORT (default 3010).
import http from 'node:http';
import { runAgent, DEFAULT_SYSTEM } from '../agent.mjs';
import { freightTools } from '../tools/freight.mjs';
import { actionTools } from '../tools/actions.mjs';
import { verifySlackSignature } from './verify.mjs';
import { policyForUser, parseActionUsers } from './permissions.mjs';
import { threadKey, getHistory, appendTurn } from './memory.mjs';
import { putPending, peekPending, takePending } from './pending.mjs';

const PORT = process.env.PORT || 3010;
const BOT_TOKEN = process.env.SLACK_BOT_TOKEN || '';
const SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET || '';
const BOT_USER_ID = process.env.SLACK_BOT_USER_ID || '';
const ACTION_USERS = parseActionUsers(process.env.SLACK_ACTION_USERS);

// Slack-only action tool: post a report/message into the CURRENT channel. The
// handler receives the live Slack context (channel/thread + a postMessage fn) at
// execution time — so it delivers something the team can actually see, unlike the
// disk-writing demo tool. Gated by the same approval flow.
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

const TOOLS = [...freightTools, ...actionTools, ...slackTools];
const toolByName = new Map(TOOLS.map((t) => [t.name, t]));

// Slack renders mrkdwn, not full markdown — steer the agent away from tables.
const SLACK_SYSTEM = `${DEFAULT_SYSTEM}\n\nYou are replying in Slack. Use Slack mrkdwn: *bold* (single asterisks), _italics_, and "• " bullets. Do NOT use markdown tables or ## headers. Keep replies tight.\n\nWhen an action tool returns {dryRun}, it has been PROPOSED and an Approve/Reject card is shown below your message. Tell the user you've proposed it and to click *Approve* to run it. Do NOT say "actions need to be enabled" — they just need to approve.`;

const seenEvents = new Set(); // dedupe Slack retries by event_id
function alreadySeen(id) {
  if (!id) return false;
  if (seenEvents.has(id)) return true;
  seenEvents.add(id);
  if (seenEvents.size > 1000) seenEvents.delete(seenEvents.values().next().value);
  return false;
}

// ---- Slack Web API helpers ------------------------------------------------
async function slackApi(method, payload) {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: `Bearer ${BOT_TOKEN}` },
    body: JSON.stringify(payload),
  });
  const j = await res.json().catch(() => ({}));
  if (!j.ok) console.warn(`[slack] ${method} failed:`, j.error || res.status);
  return j;
}
const postMessage = (channel, thread_ts, text, blocks) =>
  slackApi('chat.postMessage', { channel, thread_ts, text, blocks, unfurl_links: false });
const updateMessage = (channel, ts, text) =>
  slackApi('chat.update', { channel, ts, text, blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }] });

async function postEphemeral(responseUrl, text) {
  if (!responseUrl) return;
  await fetch(responseUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ response_type: 'ephemeral', text }),
  }).catch(() => {});
}

const cleanText = (t) => String(t || '').replace(/<@[A-Z0-9]+>/g, '').replace(/\s+/g, ' ').trim();

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
async function handleEvent(ev) {
  if (!ev || ev.bot_id || ev.subtype || (BOT_USER_ID && ev.user === BOT_USER_ID)) return;
  const isMention = ev.type === 'app_mention';
  const isDM = ev.type === 'message' && ev.channel_type === 'im';
  if (!isMention && !isDM) return;

  const userText = cleanText(ev.text);
  if (!userText) return;
  const channel = ev.channel;
  const threadTs = ev.thread_ts || ev.ts;
  const key = threadKey(channel, threadTs);

  // Slack always PROPOSES actions (never auto-executes): allowDryRunForAll lets
  // ANY requester's action become a proposal card, and execute:false ensures even
  // allowlisted users go through the button. Execution is re-gated to ACTION_USERS
  // in handleInteraction, so a teammate can ask and an authorized user approves.
  const policy = { ...policyForUser(ev.user, { actionUsers: ACTION_USERS, allowDryRunForAll: true }), execute: false };

  try {
    const { text, audit } = await runAgent({ userText, history: getHistory(key), tools: TOOLS, system: SLACK_SYSTEM, policy });
    const reply = text || '(no answer)';
    await postMessage(channel, threadTs, reply);
    appendTurn(key, userText, reply);

    // For each proposed (dry-run) action, post an Approve/Reject card.
    for (const a of audit.filter((x) => x.mode === 'dryrun')) {
      const id = putPending({ tool: a.tool, input: a.input, requestedBy: ev.user, channel, thread: threadTs });
      await postMessage(channel, threadTs, `Proposed action: ${a.tool}`, approvalBlocks(id, a.tool, a.input));
    }
  } catch (e) {
    console.error('[slack] agent error:', e.message);
    await postMessage(channel, threadTs, `⚠️ Sorry — I hit an error: ${e.message}`);
  }
}

// ---- Interaction (button) handling ---------------------------------------
async function handleInteraction(payload) {
  const clicker = payload.user?.id;
  const action = payload.actions?.[0] || {};
  const id = action.value;
  const channel = payload.channel?.id;
  const ts = payload.message?.ts;
  const pend = peekPending(id);

  if (!pend) return updateMessage(channel, ts, '⌛ This proposed action expired.');

  if (action.action_id === 'reject_action') {
    takePending(id);
    return updateMessage(channel, ts, `❌ Rejected by <@${clicker}> — \`${pend.tool}\` not run.`);
  }

  // approve — only allowlisted users may authorize execution.
  if (!ACTION_USERS.has(clicker)) {
    return postEphemeral(payload.response_url, "You're not authorized to approve actions.");
  }
  takePending(id);
  const tool = toolByName.get(pend.tool);
  if (!tool) return updateMessage(channel, ts, `⚠️ Unknown tool \`${pend.tool}\`.`);
  try {
    // Give action tools the live Slack context (channel/thread + a postMessage fn).
    const result = await tool.handler(pend.input || {}, { channel: pend.channel, thread: pend.thread, postMessage });
    const summary = result && result.error ? `error: ${result.error}` : JSON.stringify(result).slice(0, 200);
    await updateMessage(channel, ts, `✅ Approved by <@${clicker}> — \`${pend.tool}\` done.\n${summary}`);
  } catch (e) {
    await updateMessage(channel, ts, `⚠️ \`${pend.tool}\` failed: ${e.message}`);
  }
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
  if (req.method === 'GET' && (req.url === '/health' || req.url === '/')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, actionUsers: ACTION_USERS.size }));
  }
  if (req.method !== 'POST') { res.writeHead(404); return res.end(); }

  const body = await readBody(req);
  if (!verified(req, body)) { res.writeHead(401); return res.end('bad signature'); }

  // Events API (JSON)
  if (req.url.startsWith('/slack/events')) {
    let payload;
    try { payload = JSON.parse(body); } catch { res.writeHead(400); return res.end(); }
    if (payload.type === 'url_verification') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ challenge: payload.challenge }));
    }
    res.writeHead(200); res.end(); // ack fast
    if (payload.type === 'event_callback' && !alreadySeen(payload.event_id)) void handleEvent(payload.event);
    return;
  }

  // Interactivity (form-encoded: payload=<json>)
  if (req.url.startsWith('/slack/interactions')) {
    res.writeHead(200); res.end(); // ack fast
    try {
      const payload = JSON.parse(new URLSearchParams(body).get('payload'));
      if (payload.type === 'block_actions') void handleInteraction(payload);
    } catch (e) { console.error('[slack] interaction parse error:', e.message); }
    return;
  }

  res.writeHead(404); res.end();
});

server.listen(PORT, () => {
  console.log(`[slack] assistant on :${PORT} · action allowlist: ${ACTION_USERS.size} user(s)` +
    `${BOT_TOKEN ? '' : ' · WARN no SLACK_BOT_TOKEN'}${SIGNING_SECRET ? '' : ' · WARN no SLACK_SIGNING_SECRET'}`);
});
