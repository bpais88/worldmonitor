// Telegram (Bot API) request router — Marco's 5th channel, the WhatsApp/Teams twin. Telegram
// delivers updates as JSON POSTs to the webhook; we verify the secret-token header (see verify.mjs),
// ack fast, run the SAME agent as the other channels over the read-only tools, and reply via the Bot
// API through the neutral send() seam.
//
// Scope: reactive Q&A only (like WhatsApp). Watches + action tools are excluded: actions have no
// approval affordance in plain chat, and watches need a per-user scope the single team:'telegram'
// tenant doesn't yet give — both land in the proactive phase. (Telegram has no 24h reply window, so
// proactive alerts are actually easier here later than on WhatsApp.)
import { verifyTelegramSecret } from './verify.mjs';
import { runAgent, DEFAULT_SYSTEM } from '../agent.mjs';
import { DEFAULT_POLICY } from '../guardrails.mjs';
import { freightTools } from '../tools/freight.mjs';
import { weatherTools } from '../tools/weather.mjs';
import { MARCO_PERSONA } from '../slack/onboarding.mjs';
import { threadKey, getHistory, appendTurn } from '../slack/memory.mjs';
import { recordUsage } from '../usage.mjs';
import { send } from '../send.mjs';

// Read-only tool set — the exact same handlers as Slack/Teams/WhatsApp.
const TELEGRAM_TOOLS = [...freightTools, ...weatherTools];
const TELEGRAM_SYSTEM =
  `${MARCO_PERSONA}\n\n${DEFAULT_SYSTEM}\n\n` +
  'You are replying on Telegram. Keep it short and mobile-friendly — a few sentences, lead with ' +
  'the answer, in plain text (no markdown or asterisks). You only answer freight/port/weather ' +
  'questions; you cannot take actions.';
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
  // Ack fast (200) — we reply out-of-band via the API, since running the agent takes longer than the
  // webhook window, like the other adapters.
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end('{}');
  let update;
  try { update = JSON.parse(body || '{}'); } catch { return; }
  void dispatch(update);
}

async function dispatch(update) {
  const msg = update.message || update.edited_message;
  const chatId = msg?.chat?.id;
  const text = (msg?.text || '').trim();
  if (!chatId || !text) return; // ignore non-text updates (photos, joins, etc.)
  const user = String(chatId);
  console.log(`[telegram] msg from ${user}: "${text.slice(0, 100)}"`);

  const install = { platform: 'telegram', deliver: { chatId } };
  const key = threadKey('telegram', user); // one conversation thread per chat

  try {
    const { text: reply, usage, calls } = await runAgent({
      userText: text,
      history: await getHistory(key),
      tools: TELEGRAM_TOOLS,
      system: TELEGRAM_SYSTEM,
      policy: DEFAULT_POLICY, // read-only
      context: { channel: user, user, team: 'telegram', platform: 'telegram', deliver: install.deliver },
    });
    const out = (reply || '(no answer)').slice(0, MAX_REPLY);
    const day = await recordUsage('telegram', usage);
    console.log(`[telegram]   → tools: ${calls.join(', ') || 'none'} · ${usage.input}+${usage.output} tok · replied ${out.length} chars` +
      (day ? ` · today ${day.messages} msg` : ''));
    await send(install, { text: out }); // Telegram routes by install.deliver.chatId
    await appendTurn(key, text, out);
  } catch (e) {
    console.error('[telegram] agent error:', e.message);
    await send(install, { text: `⚠️ Sorry — I hit an error: ${e.message}` }).catch(() => {});
  }
}
