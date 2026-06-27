// Platform-neutral delivery layer. The Slack — and later Teams — adapters reach
// their platform ONLY through send()/update()/dm(), each taking an opaque `install`
// record and branching on install.platform. This is the seam that lets one brain
// serve both Slack and Teams: the agent reply path, the approval flow, and the
// proactive watch ticker call these and never touch a platform API directly.
//
// `install` shape: { platform: 'slack' | 'teams', deliver, ... }. For Slack,
// `deliver` is the workspace bot token; for Teams (later) it will be a conversation
// reference. deliverFor() resolves it, tolerating legacy Slack records persisted
// before generalization that only carry `botToken`.

import { deliverFor } from './slack/installations.mjs';

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

/** Post a message (optionally a thread reply, optionally with platform blocks/cards). */
export async function send(install, { channelId, threadId, text, blocks }) {
  if (install?.platform === 'teams') throw new Error('send: teams delivery not wired yet');
  return slackApi('chat.postMessage', { channel: channelId, thread_ts: threadId, text, blocks, unfurl_links: false }, deliverFor(install));
}

/** Edit a previously-sent message in place (used to resolve approval cards). */
export async function update(install, { channelId, messageId, text }) {
  if (install?.platform === 'teams') throw new Error('update: teams delivery not wired yet');
  return slackApi('chat.update', { channel: channelId, ts: messageId, text, blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }] }, deliverFor(install));
}

/** Open a DM with a user and post to it (the onboarding "magic moment"). */
export async function dm(install, { userId, text }) {
  if (install?.platform === 'teams') throw new Error('dm: teams delivery not wired yet');
  const token = deliverFor(install);
  const open = await slackApi('conversations.open', { users: userId }, token);
  const channel = open.channel?.id;
  if (channel) return slackApi('chat.postMessage', { channel, text, unfurl_links: false }, token);
}
