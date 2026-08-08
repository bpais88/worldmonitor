// Telegram (Bot API) request router — Marco's 5th channel, the WhatsApp/Teams twin. Telegram
// delivers updates as JSON POSTs to the webhook; we verify the secret-token header (see verify.mjs),
// ack fast, run the SAME agent as the other channels over the read-only tools, and reply via the Bot
// API through the neutral send() seam.
//
// Scope: reactive Q&A + watches (proactive phase, 2026-07-07). Telegram has no 24h reply window,
// so proactive watch alerts send as plain Bot API messages — no template machinery needed (the
// WhatsApp twin carries that). Watches are per-user tenants (channel-turn passes team
// `telegram:<chatId>`) so list/cancel can't cross-leak between chats. Action tools stay excluded:
// actions have no approval affordance in plain chat.
import { verifyTelegramSecret } from './verify.mjs';
import { DEFAULT_SYSTEM } from '../agent.mjs';
import { freightTools } from '../tools/freight.mjs';
import { profileTools } from '../tools/profiles.mjs';
import { weatherTools } from '../tools/weather.mjs';
import { watchTools } from '../tools/watches.mjs';
import { MARCO_PERSONA } from '../slack/onboarding.mjs';
import { runChannelTurn } from '../channel-turn.mjs';

// Same read-only handlers as Slack/Teams/WhatsApp, + the watch tools (read-class, no approval gate).
const TELEGRAM_TOOLS = [...freightTools, ...profileTools, ...weatherTools, ...watchTools];
const TELEGRAM_SYSTEM =
  `${MARCO_PERSONA}\n\n${DEFAULT_SYSTEM}\n\n` +
  'You are replying on Telegram. Keep it short and mobile-friendly — a few sentences, lead with ' +
  'the answer, in plain text (no markdown or asterisks). You only answer freight/port/weather ' +
  'questions; you cannot take actions, but you CAN set proactive watches ("watch Genoa", "alert ' +
  'me when Rotterdam clears") — alerts arrive right here.';
const MAX_REPLY = 3500; // Telegram's hard limit is 4096 chars — keep a margin.
// The secret_token we set on the webhook, echoed back in the header (see verify.mjs). Read once at
// load, matching connector.mjs — a Railway env change redeploys anyway, so nothing is lost hoisting.
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || '';

export async function handleTelegramRequest(req, res, body) {
  const ok = verifyTelegramSecret({
    provided: req.headers['x-telegram-bot-api-secret-token'],
    expected: WEBHOOK_SECRET,
  });
  if (!ok) {
    console.warn('[telegram] webhook auth rejected');
    res.writeHead(403);
    return res.end();
  }
  // Ack fast (bare 200) — we reply out-of-band via the API, since running the agent takes longer
  // than the webhook window, like the other adapters.
  res.writeHead(200);
  res.end();
  let update;
  try { update = JSON.parse(body || '{}'); } catch { return; }
  void dispatch(update);
}

async function dispatch(update) {
  const msg = update.message || update.edited_message;
  const chatId = msg?.chat?.id;
  const text = (msg?.text || '').trim();
  if (!chatId || !text) return; // ignore non-text updates (photos, joins, etc.)
  // Transport-specific bits done; the reactive-Q&A core is shared across the plain-chat channels.
  await runChannelTurn({
    platform: 'telegram',
    user: String(chatId), // one conversation thread per chat
    text,
    deliver: { chatId }, // send() routes Telegram by deliver.chatId
    tools: TELEGRAM_TOOLS,
    system: TELEGRAM_SYSTEM,
    maxReply: MAX_REPLY,
  });
}
