// Inbound webhook auth for the Telegram adapter — a shared secret in a request header.
//
// When we register the webhook (setWebhook) we pass `secret_token`; Telegram then echoes it back in
// the `X-Telegram-Bot-Api-Secret-Token` header on every update. We verify it (constant-time) against
// TELEGRAM_WEBHOOK_SECRET, fail-closed. Simpler than Twilio: no signature, no URL userinfo — Telegram
// designed this header for exactly this. (https://core.telegram.org/bots/api#setwebhook)
//
// The shared-secret check itself lives in ../secret.mjs (also used by the WhatsApp adapter); the
// router calls it with `provided: req.headers['x-telegram-bot-api-secret-token']`.
export { verifyWebhookSecret as verifyTelegramSecret } from '../secret.mjs';
