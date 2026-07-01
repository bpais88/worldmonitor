// Shared inbound-auth primitives for the webhook adapters. `constantTimeEqual` is the timing-safe
// byte compare every adapter needs; `verifyWebhookSecret` is the shared-secret check used by the
// WhatsApp (`?k=` query param) and Telegram (`X-Telegram-Bot-Api-Secret-Token` header) adapters —
// both just compare a caller-provided secret against one we set. (Slack HMAC and Teams JWT are
// different schemes with their own verify modules; they can adopt constantTimeEqual in a follow-up.)
import crypto from 'node:crypto';

// Constant-time compare over UTF-8 bytes; tolerates length mismatch without leaking via throw.
export function constantTimeEqual(a, b) {
  const ab = Buffer.from(String(a), 'utf-8');
  const bb = Buffer.from(String(b), 'utf-8');
  if (ab.length !== bb.length) return false;
  try { return crypto.timingSafeEqual(ab, bb); } catch { return false; }
}

/** Verify a caller-provided shared secret against the expected one. Fail-closed on missing input. */
export function verifyWebhookSecret({ provided, expected }) {
  if (!expected || !provided) return false;
  return constantTimeEqual(provided, expected);
}
