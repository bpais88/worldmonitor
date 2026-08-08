// Telegram Bot API send — the outbound half of the Telegram adapter. POSTs to the Bot API's
// sendMessage with the bot token in the URL. No dependency — mirrors teams/whatsapp connectors.
// Reached only through send.mjs's telegram branch. Plain text (no parse_mode) to avoid Telegram's
// strict Markdown escaping rules breaking on vessel names / punctuation; Marco is told to reply plainly.
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';

export async function sendTelegram({ chatId, text }) {
  if (!TELEGRAM_BOT_TOKEN || !chatId) {
    console.warn('[telegram] send skipped (missing bot token or chat)');
    return { ok: false };
  }
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
  });
  const j = await res.json().catch(() => ({}));
  if (!j.ok) console.warn('[telegram] send failed:', j.description || res.status);
  return { ok: !!j.ok, messageId: j.result?.message_id };
}
