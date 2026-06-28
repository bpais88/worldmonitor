// Normalize an inbound Teams (Bot Framework) Activity into the platform-neutral
// shape the brain expects — the Teams mirror of the Slack adapter's event reads.
// Pure (no I/O), so it unit-tests against captured Activity payloads.

// Strip Teams mention spans (<at>Name</at>) so the agent sees a clean prompt,
// mirroring the Slack adapter stripping <@U…> mentions.
const stripMentions = (text) => String(text || '')
  .replace(/<at\b[^>]*\/>/gi, '')        // self-closing <at .../>
  .replace(/<at\b[^>]*>.*?<\/at>/gi, '') // paired <at>…</at>
  .replace(/\s+/g, ' ').trim();

/**
 * Map an Activity to { tenantId, channelId, threadId, userId, text } plus the
 * delivery/context fields the adapter needs (serviceUrl, conversationType,
 * activityId, and the channel accounts for the reply). Every id is an opaque
 * string — the core already treats them so.
 */
export function normalizeTeamsActivity(activity = {}) {
  const conv = activity.conversation || {};
  return {
    tenantId: activity.channelData?.tenant?.id || conv.tenantId || '',
    channelId: conv.id || '',
    threadId: activity.replyToId || conv.id || '',
    userId: activity.from?.aadObjectId || '',
    text: stripMentions(activity.text),
    serviceUrl: activity.serviceUrl || '',
    conversationType: conv.conversationType || 'personal', // 'personal' | 'channel' | 'groupChat'
    activityId: activity.id || '',
    // Channel accounts for building a valid outbound reply: the Connector rejects (400) a
    // reply that omits from/recipient. Outbound `from` = the bot (the inbound recipient),
    // outbound `recipient` = the user (the inbound from). Also the seed of the proactive
    // conversation reference persisted in a later PR.
    botAccount: activity.recipient || undefined,
    userAccount: activity.from || undefined,
    locale: activity.locale || undefined,
  };
}

/**
 * The send.mjs Teams delivery handle for a normalized activity (outbound `from` = the bot,
 * `recipient` = the user). Built once here so the reply path and the proactive/onboarding
 * path that persists it can never disagree on the conversation reference.
 */
export const toTeamsDeliver = (n) => ({
  serviceUrl: n.serviceUrl, from: n.botAccount, recipient: n.userAccount, locale: n.locale,
});

/**
 * Whether the bot should answer this message. In personal (1:1) chat it always
 * responds; in channels / group chats only when @mentioned — verified against the
 * bot's own id in the entities list, NOT by parsing text (which is forgeable).
 * Mirrors the Slack adapter's app_mention vs message.im split.
 */
export function shouldRespond(activity = {}) {
  const type = activity.conversation?.conversationType || 'personal';
  if (type === 'personal') return true;
  const botId = activity.recipient?.id;
  return (activity.entities || []).some((e) => e.type === 'mention' && e.mentioned?.id && e.mentioned.id === botId);
}
