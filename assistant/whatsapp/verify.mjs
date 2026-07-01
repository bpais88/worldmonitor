// Inbound webhook auth for the WhatsApp adapter — a shared secret carried in the webhook URL.
//
// Why not X-Twilio-Signature: Twilio signs webhooks only with the account-wide Auth Token, and the
// same Twilio account runs Marco's voice number — holding/rotating that token has blast radius.
// Why not Basic-auth-in-URL (https://user:pass@host): Twilio does NOT reliably forward the userinfo
// as an `Authorization` header (verified in prod — our requests arrived with no auth header at all).
// The robust no-Auth-Token channel is a secret query param: Twilio preserves the configured URL's
// query string verbatim on every webhook. Configure the webhook as
//   https://host/whatsapp?k=<WHATSAPP_WEBHOOK_SECRET>
// Marco is read-only, so authenticity (proof the caller is our Twilio) is the property that matters.
import crypto from 'node:crypto';

// Constant-time compare over UTF-8 bytes; tolerates length mismatch without leaking via throw.
function safeEqual(a, b) {
  const ab = Buffer.from(String(a), 'utf-8');
  const bb = Buffer.from(String(b), 'utf-8');
  if (ab.length !== bb.length) return false;
  try { return crypto.timingSafeEqual(ab, bb); } catch { return false; }
}

/** Verify the shared secret Twilio carries in the webhook URL's `?k=` param. Fail-closed. */
export function verifyWebhookSecret({ provided, expected }) {
  if (!expected || !provided) return false;
  return safeEqual(provided, expected);
}
