// Teams (Bot Framework) request router — the Teams adapter's receive half, mirroring the
// Slack adapter: verify the inbound request, ack fast (<5s), then run the agent async and
// reply through the platform-neutral send() seam.
//
// Scope (PR3): read-class Q&A — Marco answers freight/weather questions on Teams with the
// same brain as Slack. Approval-gated ACTIONS (Adaptive cards) and proactive watch alerts
// (which need a stored conversation reference + a Teams install record) land in later PRs.
import { verifyTeamsToken } from './verify.mjs';
import { normalizeTeamsActivity, shouldRespond, toTeamsDeliver } from './normalize.mjs';
import { runAgent, DEFAULT_SYSTEM } from '../agent.mjs';
import { DEFAULT_POLICY } from '../guardrails.mjs';
import { freightTools } from '../tools/freight.mjs';
import { weatherTools } from '../tools/weather.mjs';
import { watchTools } from '../tools/watches.mjs';
import { recordUsage } from '../usage.mjs';
import { send } from '../send.mjs';
import { recordTeamsConversation, markTeamsOnboarded } from './installations.mjs';
import { shouldGreet, teamsOnboardingText } from './onboarding.mjs';
// TODO: MARCO_PERSONA + thread memory are platform-neutral but currently live under slack/;
// Teams is now their 2nd consumer, so they should move to neutral modules in a follow-up.
import { MARCO_PERSONA } from '../slack/onboarding.mjs';
import { threadKey, getHistory, appendTurn } from '../slack/memory.mjs';

const MS_APP_ID = process.env.MS_APP_ID || '';

// Read-class tools: freight/weather Q&A + proactive watches (watch creation is read-class —
// no approval gate). Side-effecting ACTION tools (post report) still need the Adaptive-card
// approval flow (PR④).
const TEAMS_TOOLS = [...freightTools, ...weatherTools, ...watchTools];

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
    await onConversationUpdate(activity);
    return;
  }
  if (activity.type !== 'message' || !shouldRespond(activity)) return;

  const n = normalizeTeamsActivity(activity);
  if (!n.text) return;
  console.log(`[teams] msg @${n.userId} in ${n.tenantId}/${n.channelId}: "${n.text.slice(0, 100)}"`);

  // The conversation reference for this turn — used for the reply AND stamped on any watch
  // created this turn (so the proactive ticker can alert this conversation later). Built once.
  const deliver = toTeamsDeliver(n);
  const install = { platform: 'teams', deliver };
  const key = threadKey(`${n.tenantId}:${n.channelId}`, n.threadId);

  try {
    const { text, usage, calls } = await runAgent({
      userText: n.text,
      history: await getHistory(key),
      tools: TEAMS_TOOLS,
      system: TEAMS_SYSTEM,
      policy: DEFAULT_POLICY, // read-class tools only (Q&A + watches); no side-effecting actions yet
      // platform + deliver let a watch created here carry its own delivery handle (Teams has
      // no per-tenant token), so the proactive ticker can alert this conversation later.
      context: { channel: n.channelId, thread: n.threadId, user: n.userId, team: n.tenantId, platform: 'teams', deliver },
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

// First contact: capture/refresh the conversation reference (the unit proactive watch
// alerts will resume — see installations.mjs), and greet exactly once when the bot itself
// was just added to a 1:1. The welcome posts straight to the conversationUpdate's own
// conversation, so no Bot Framework "create conversation" call is needed.
async function onConversationUpdate(activity) {
  const n = normalizeTeamsActivity(activity);
  if (!n.channelId) return;
  try {
    // Capture/refresh the conversation reference through the SAME extraction the reply path
    // uses (normalize + toTeamsDeliver), so the persisted, proactive-only reference can't drift.
    const rec = await recordTeamsConversation({
      conversationId: n.channelId,
      tenantId: n.tenantId,
      conversationType: n.conversationType,
      deliver: toTeamsDeliver(n),
    });
    if (shouldGreet(activity) && !rec.onboarded) {
      // Mark onboarded ONLY after a confirmed-delivered (2xx) welcome, so a transient
      // token/network/non-2xx failure leaves onboarded=false and retries on the next add
      // — rather than silently burning the one-shot greeting.
      const res = await send({ platform: 'teams', deliver: rec.deliver }, { channelId: n.channelId, text: teamsOnboardingText(n.conversationType) })
        .catch((e) => { console.warn('[teams] onboarding send failed:', e.message); return null; });
      if (res && res.ok) {
        await markTeamsOnboarded(rec);
        console.log(`[teams] onboarded ${n.channelId} (welcome sent)`);
      } else {
        console.warn(`[teams] onboarding deferred for ${n.channelId} (welcome not delivered) — will retry on next add`);
      }
    } else {
      console.log(`[teams] conversationUpdate in ${n.channelId} (type=${n.conversationType})`);
    }
  } catch (e) {
    console.warn('[teams] conversationUpdate handling failed:', e.message);
  }
}
