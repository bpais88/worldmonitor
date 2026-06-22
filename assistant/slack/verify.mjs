// Slack request-signature verification (https://api.slack.com/authentication/verifying-requests-from-slack).
// Slack signs each request as HMAC-SHA256 over `v0:<timestamp>:<rawBody>` keyed by
// the app signing secret. We also reject stale timestamps to prevent replay.
import crypto from 'node:crypto';

export function verifySlackSignature({ signingSecret, signature, timestamp, body, now = Date.now() }) {
  if (!signingSecret || !signature || !timestamp) return false;
  // Reject requests older than 5 minutes (replay protection).
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(now / 1000 - ts) > 60 * 5) return false;

  const expected = 'v0=' + crypto.createHmac('sha256', signingSecret)
    .update(`v0:${timestamp}:${body}`)
    .digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
