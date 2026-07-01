// Inbound webhook auth for the WhatsApp adapter — HTTP Basic auth, NOT X-Twilio-Signature.
//
// Why Basic auth: Twilio signs webhooks (X-Twilio-Signature) only with the account-wide Auth
// Token, so validating a signature would force us to hold that token. Instead we configure the
// Twilio webhook URL as https://user:pass@host/whatsapp — Twilio strips the userinfo and sends
// it as an `Authorization: Basic` header (https://www.twilio.com/docs/usage/webhooks/webhooks-connection-overrides).
// The password is a secret WE own (WHATSAPP_WEBHOOK_SECRET), independent of the Twilio account,
// so it can be rotated in isolation and never exposes account-wide creds. Marco is read-only, so
// authenticity (proof the caller is Twilio) is the property that matters — not per-request integrity.
import crypto from 'node:crypto';

// Non-secret username baked into the webhook URL; keeps the Basic credential well-formed and lets
// the URL read as https://marco:<secret>@host/whatsapp. The secret is the password half.
export const WEBHOOK_USER = 'marco';

// Constant-time compare over UTF-8 bytes; tolerates length mismatch without leaking via throw.
function safeEqual(a, b) {
  const ab = Buffer.from(String(a), 'utf-8');
  const bb = Buffer.from(String(b), 'utf-8');
  if (ab.length !== bb.length) return false;
  try { return crypto.timingSafeEqual(ab, bb); } catch { return false; }
}

/**
 * Verify the HTTP Basic credential Twilio sends for a userinfo-authenticated webhook URL.
 * `header` is the raw `Authorization` header. Fail-closed on any missing/malformed input.
 */
export function verifyWebhookBasicAuth({ header, expectedSecret }) {
  if (!expectedSecret || !header) return false;
  const m = /^Basic\s+(.+)$/i.exec(header.trim());
  if (!m) return false;
  let decoded;
  try { decoded = Buffer.from(m[1], 'base64').toString('utf-8'); } catch { return false; }
  const i = decoded.indexOf(':');
  if (i < 0) return false;
  // Username isn't secret (it's in the URL), so its compare needn't be constant-time; the secret's must be.
  return decoded.slice(0, i) === WEBHOOK_USER && safeEqual(decoded.slice(i + 1), expectedSecret);
}
