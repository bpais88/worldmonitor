// Marco's Teams first-run "magic moment" — the welcome he posts the instant he's installed,
// turning "I added a bot" into "I hired someone". The voice (MARCO_PERSONA) is shared with
// Slack, but the copy lives here because Teams renders standard Markdown (no Slack mrkdwn),
// and the call-to-action differs by where he was added (1:1 vs a team channel).

/**
 * True when THIS conversationUpdate is the bot itself being added (install / add-to-team) —
 * verified against the bot's own id in membersAdded, not by any text. The signal to greet.
 */
export function botWasAdded(activity = {}) {
  const botId = activity.recipient?.id;
  return !!botId && (activity.membersAdded || []).some((m) => m && m.id === botId);
}

/**
 * Whether THIS conversationUpdate should trigger the first-run welcome: the bot was just
 * added to a 1:1 (personal) chat. Channels / group chats are captured (for proactive
 * delivery) but not auto-greeted, to avoid posting into a shared space uninvited.
 * Mirrors normalize.shouldRespond — the greet policy living beside the respond policy.
 */
export function shouldGreet(activity = {}) {
  const type = activity.conversation?.conversationType || 'personal';
  return botWasAdded(activity) && type === 'personal';
}

/** The first-run intro message (Teams Markdown). conversationType tailors the call-to-action. */
export function teamsOnboardingText(conversationType = 'personal') {
  const cta = conversationType === 'personal'
    ? 'Just message me here — no setup.'
    : '**@mention me** in any channel and I’ll jump in.';
  // Note: read-only Q&A only for now. The "watch X and ping me when it changes" CTA is
  // intentionally omitted until Teams watch creation + proactive alerts land (PR⑤b) — don't
  // advertise a flow the Teams adapter can't fulfil yet.
  return [
    "👋 Ciao, I’m **Marco** — your freight-ops coworker. I track every commercial cargo ship and RoPax ferry moving through Italian ports, live.",
    '',
    "You don’t have to connect anything — I already see the data. " + cta,
    '',
    '**Try me:**',
    '- *Which ports are congested right now?*',
    '- *Any delays at Genoa?*',
    '- *Where’s the MOBY FANTASY?*',
    '',
    'Ask me about any Italian port or operator — Genoa, Livorno, Civitavecchia… MOBY, Tirrenia, GNV…',
  ].join('\n');
}
