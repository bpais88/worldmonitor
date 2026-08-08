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
import { profileTools } from '../tools/profiles.mjs';
import { weatherTools } from '../tools/weather.mjs';
import { watchTools } from '../tools/watches.mjs';
import { actionTools } from '../tools/actions.mjs';
import { cancelWatchesByConversation } from '../watches.mjs';
import { putPending, peekPending, takePending } from '../slack/pending.mjs';
import { approvalCard, isCardSubmit } from './cards.mjs';
import { recordUsage } from '../usage.mjs';
import { send, update } from '../send.mjs';
import { recordTeamsConversation, markTeamsOnboarded, removeTeamsInstall } from './installations.mjs';
import { shouldGreet, teamsOnboardingText, botWasRemoved } from './onboarding.mjs';
// TODO: MARCO_PERSONA + thread memory are platform-neutral but currently live under slack/;
// Teams is now their 2nd consumer, so they should move to neutral modules in a follow-up.
import { MARCO_PERSONA } from '../slack/onboarding.mjs';
import { threadKey, getHistory, appendTurn } from '../slack/memory.mjs';

const MS_APP_ID = process.env.MS_APP_ID || '';

// Read-class Q&A + watches PLUS side-effecting ACTION tools, gated by the propose-then-approve
// Adaptive-card flow (PR④). Read tools execute; action tools are proposed (dry-run) and only
// run after an Approve click.
const TEAMS_TOOLS = [...freightTools, ...profileTools, ...weatherTools, ...watchTools, ...actionTools];
const TEAMS_TOOL_BY_NAME = new Map(TEAMS_TOOLS.map((t) => [t.name, t]));

// Like Slack: actions are ALLOWED but never auto-executed — execute:false forces every action
// tool into a dry-run proposal that the human resolves via the card. Read tools still execute.
const TEAMS_POLICY = { ...DEFAULT_POLICY, allowActions: true, execute: false };

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
  // An Adaptive-card Approve/Reject click arrives as a message with `value` and no text —
  // route it to the approval handler, not the agent.
  if (isCardSubmit(activity)) {
    await handleApproval(activity);
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
    const { text, usage, calls, audit } = await runAgent({
      userText: n.text,
      history: await getHistory(key),
      tools: TEAMS_TOOLS,
      system: TEAMS_SYSTEM,
      policy: TEAMS_POLICY, // read tools execute; action tools become Approve/Reject proposals
      // platform + deliver let a watch created here carry its own delivery handle (Teams has
      // no per-tenant token), so the proactive ticker can alert this conversation later.
      context: { channel: n.channelId, thread: n.threadId, user: n.userId, team: n.tenantId, platform: 'teams', deliver },
    });
    const reply = text || '(no answer)';
    const day = await recordUsage(n.tenantId, usage);
    const dryruns = audit.filter((x) => x.mode === 'dryrun');
    console.log(`[teams]   → tools: ${calls.join(', ') || 'none'}${dryruns.length ? ` · ${dryruns.length} proposed` : ''} · ${usage.input}+${usage.output} tok · replied ${reply.length} chars` +
      (day ? ` · today ${day.messages} msg / ${day.input + day.output} tok` : ''));
    // Reply to the user's message (replyToId = the inbound activity id).
    await send(install, { channelId: n.channelId, threadId: n.activityId, text: reply });
    await appendTurn(key, n.text, reply);
    // Post an Approve/Reject Adaptive Card for each proposed (dry-run) action.
    for (const a of dryruns) {
      const id = await putPending({ tool: a.tool, input: a.input, requestedBy: n.userId, team: n.tenantId, channel: n.channelId });
      await send(install, { channelId: n.channelId, threadId: n.activityId, card: approvalCard(id, a.tool, a.input) });
    }
  } catch (e) {
    console.error('[teams] agent error:', e.message);
    // Mirror Slack: tell the user instead of staying silent (best-effort).
    await send(install, { channelId: n.channelId, threadId: n.activityId, text: `⚠️ Sorry — I hit an error: ${e.message}` }).catch(() => {});
  }
}

// An Adaptive-card Approve/Reject click (object-data Action.Submit). Re-authorize the clicker,
// run or drop the proposed action, and PUT the card to a terminal state in place. Auth =
// requester-only (the proposer's aadObjectId must match the clicker), tenant-scoped — a
// designated-approver allowlist (Slack parity) needs a Teams config store (future).
async function handleApproval(activity) {
  const { actionId, decision } = activity.value || {};
  const clicker = activity.from?.aadObjectId || '';
  const tenantId = activity.channelData?.tenant?.id || activity.conversation?.tenantId || '';
  const conversationId = activity.conversation?.id || '';
  const install = { platform: 'teams', deliver: { serviceUrl: activity.serviceUrl } };
  // Resolve the card in place; activity.replyToId is the card message's id (the PUT target).
  const resolve = (text) => update(install, { channelId: conversationId, messageId: activity.replyToId, text })
    .catch((e) => console.warn('[teams] card update failed:', e.message));

  const pend = await peekPending(actionId);
  if (!pend) return resolve('⌛ This proposed action expired.');

  if (decision === 'reject') {
    await takePending(actionId);
    console.log(`[teams] action ${pend.tool} rejected by ${clicker}`);
    return resolve(`❌ Rejected — **${pend.tool}** not run.`);
  }
  // Approve — only the requester may run their own proposed action, within its tenant. On an
  // unauthorized click, LEAVE the card live (no resolve/take) so the legitimate requester can
  // still approve — just log it (Teams has no per-click ephemeral reply to scold the clicker).
  if (pend.requestedBy && clicker !== pend.requestedBy) {
    console.log(`[teams] unauthorized approve on ${pend.tool} by ${clicker} (requester ${pend.requestedBy}) — card left live`);
    return;
  }
  if (pend.team && tenantId && pend.team !== tenantId) {
    console.log(`[teams] cross-tenant approve refused on ${pend.tool} (${tenantId} vs ${pend.team}) — card left live`);
    return;
  }

  await takePending(actionId);
  const tool = TEAMS_TOOL_BY_NAME.get(pend.tool);
  if (!tool) return resolve(`⚠️ Unknown tool **${pend.tool}**.`);
  try {
    const result = await tool.handler(pend.input || {}, { channel: conversationId, team: tenantId, user: clicker });
    const summary = result && result.error ? `error: ${result.error}` : JSON.stringify(result).slice(0, 200);
    console.log(`[teams] action ${pend.tool} approved + run by ${clicker}`);
    return resolve(`✅ Approved — **${pend.tool}** done.\n${summary}`);
  } catch (e) {
    return resolve(`⚠️ **${pend.tool}** failed: ${e.message}`);
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
    // Bot removed from this conversation → Slack-parity cleanup: drop the install record and
    // cancel any watches bound here, so the ticker stops evaluating + alerting a dead chat.
    if (botWasRemoved(activity)) {
      await removeTeamsInstall(n.channelId);
      const cancelled = await cancelWatchesByConversation({ team: n.tenantId, conversationId: n.channelId });
      console.log(`[teams] removed ${n.channelId} (install cleared, ${cancelled} watch(es) cancelled)`);
      return;
    }
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
