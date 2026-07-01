// Inbound webhook auth for the Telegram adapter — a shared secret in a request header.
//
// When we register the webhook (setWebhook) we pass `secret_token`; Telegram then echoes it back in
// the `X-Telegram-Bot-Api-Secret-Token` header on every update. We verify it (constant-time) against
// TELEGRAM_WEBHOOK_SECRET, fail-closed. Simpler than Twilio: no signature, no URL userinfo — Telegram
// designed this header for exactly this. (https://core.telegram.org/bots/api#setwebhook)
import crypto from 'node:crypto';

// Constant-time compare over UTF-8 bytes; tolerates length mismatch without leaking via throw.
function safeEqual(a, b) {
  const ab = Buffer.from(String(a), 'utf-8');
  const bb = Buffer.from(String(b), 'utf-8');
  if (ab.length !== bb.length) return false;
  try { return crypto.timingSafeEqual(ab, bb); } catch { return false; }
}

/** Verify Telegram's X-Telegram-Bot-Api-Secret-Token header against our secret. Fail-closed. */
export function verifyTelegramSecret({ provided, expected }) {
  if (!expected || !provided) return false;
  return safeEqual(provided, expected);
}
