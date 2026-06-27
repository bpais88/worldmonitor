// Teams (Bot Framework) request router — the Teams adapter's receive half, mirroring the
// Slack adapter: verify the inbound request, ack fast (<5s), then run the agent async and
// reply through the platform-neutral send() seam.
//
// Scope (PR3): read-class Q&A — Marco answers freight/weather questions on Teams with the
// same brain as Slack. Approval-gated ACTIONS (Adaptive cards) and proactive watch alerts
// (which need a stored conversation reference + a Teams install record) land in later PRs.
import { verifyTeamsToken } from './verify.mjs';
import { normalizeTeamsActivity, shouldRespond } from './normalize.mjs';
import { runAgent, DEFAULT_SYSTEM } from '../agent.mjs';
import { DEFAULT_POLICY } from '../guardrails.mjs';
import { freightTools } from '../tools/freight.mjs';
import { weatherTools } from '../tools/weather.mjs';
import { recordUsage } from '../usage.mjs';
import { send } from '../send.mjs';
// TODO: MARCO_PERSONA + thread memory are platform-neutral but currently live under slack/;
// Teams is now their 2nd consumer, so they should move to neutral modules in a follow-up.
import { MARCO_PERSONA } from '../slack/onboarding.mjs';
import { threadKey, getHistory, appendTurn } from '../slack/memory.mjs';

const MS_APP_ID = process.env.MS_APP_ID || '';

// Read-class tools only for now (Q&A). Action tools (post report) need the Adaptive-card
// approval flow (next PR); watches need a Teams install record for proactive delivery.
const TEAMS_TOOLS = [...freightTools, ...weatherTools];

// Marco's voice + the analyst base, with Teams markdown rules (Teams renders standard
// Markdown — no Slack mrkdwn quirks).
const TEAMS_SYSTEM = `${MARCO_PERSONA}\n\n${DEFAULT_SYSTEM}\n\nYou are replying in Microsoft Teams. Use standard Markdown: **bold**, bullet lists, and small tables when useful. Keep replies tight.`;

export async function handleTeamsRequest(req, res, body) {
  let activity;
  try { activity = JSON.parse(body); } catch { res.writeHead(400); return res.end(); }

  // Verify the Microsoft-signed JWT (incl. the serviceUrl anti-spoof). 403 on failure.
  try {
    await verifyTeamsToken({ authHeader: req.headers.authorization, appId: MS_APP_ID, serviceUrl: activity.serviceUrl });
  } catch (e) {
    console.warn('[teams] auth rejected:', e.message);
    res.writeHead(403); return res.end();
  }

  res.writeHead(200); res.end(); // ack fast, like the Slack adapter
  void dispatch(activity);
}

async function dispatch(activity) {
  if (activity.type === 'conversationUpdate') {
    // First contact / install — the conversation-reference capture lands in a later PR.
    console.log(`[teams] conversationUpdate in ${activity.conversation?.id}`);
    return;
  }
  if (activity.type !== 'message' || !shouldRespond(activity)) return;

  const n = normalizeTeamsActivity(activity);
  if (!n.text) return;
  console.log(`[teams] msg @${n.userId} in ${n.tenantId}/${n.channelId}: "${n.text.slice(0, 100)}"`);

  // The conversation reference for this turn's reply: serviceUrl + the channel accounts
  // the Connector requires on a reply (outbound from = the bot, recipient = the user).
  const install = { platform: 'teams', deliver: { serviceUrl: n.serviceUrl, from: n.botAccount, recipient: n.userAccount, locale: n.locale } };
  const key = threadKey(`${n.tenantId}:${n.channelId}`, n.threadId);

  try {
    const { text, usage, calls } = await runAgent({
      userText: n.text,
      history: await getHistory(key),
      tools: TEAMS_TOOLS,
      system: TEAMS_SYSTEM,
      policy: DEFAULT_POLICY, // read-only on Teams for now (no action tools wired)
      context: { channel: n.channelId, thread: n.threadId, user: n.userId, team: n.tenantId },
    });
    const reply = text || '(no answer)';
    const day = await recordUsage(n.tenantId, usage);
    console.log(`[teams]   → tools: ${calls.join(', ') || 'none'} · ${usage.input}+${usage.output} tok · replied ${reply.length} chars` +
      (day ? ` · today ${day.messages} msg / ${day.input + day.output} tok` : ''));
    // Reply to the user's message (replyToId = the inbound activity id).
    await send(install, { channelId: n.channelId, threadId: n.activityId, text: reply });
    await appendTurn(key, n.text, reply);
  } catch (e) {
    console.error('[teams] agent error:', e.message);
    // Mirror Slack: tell the user instead of staying silent (best-effort).
    await send(install, { channelId: n.channelId, threadId: n.activityId, text: `⚠️ Sorry — I hit an error: ${e.message}` }).catch(() => {});
  }
}
