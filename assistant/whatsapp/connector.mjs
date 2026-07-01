// Twilio WhatsApp send — the outbound half of the WhatsApp adapter. Posts to the Twilio
// Messages API (Basic auth = ApiKeySid:ApiKeySecret, or AccountSid:AuthToken as a fallback).
// No `twilio` dependency — mirrors how teams/connector.mjs owns the Teams wire calls. Reached
// only through send.mjs's whatsapp branch.

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || '';
// REST auth: prefer a scoped API key (SK…:secret) over the account-wide Auth Token; either pair is
// valid Basic auth for the Twilio API (the URL still addresses the account SID). Select the pair
// ATOMICALLY — a half-set API key must not borrow the Auth Token as its password, which would form
// a mismatched pair Twilio 401s while slipping past the local guard.
const [AUTH_USER, AUTH_PASS] = process.env.TWILIO_API_KEY_SID
  ? [process.env.TWILIO_API_KEY_SID, process.env.TWILIO_API_KEY_SECRET || '']
  : [TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN || ''];
// The WhatsApp sender, e.g. "whatsapp:+14155238886" (the Twilio sandbox or your approved sender).
const TWILIO_WHATSAPP_FROM = process.env.TWILIO_WHATSAPP_FROM || '';

const asWhatsApp = (n) => (n.startsWith('whatsapp:') ? n : `whatsapp:${n}`);
const AUTH_HEADER = `Basic ${Buffer.from(`${AUTH_USER}:${AUTH_PASS}`).toString('base64')}`;

export async function sendWhatsApp({ to, text }) {
  if (!TWILIO_ACCOUNT_SID || !AUTH_PASS || !TWILIO_WHATSAPP_FROM || !to) {
    console.warn('[whatsapp] send skipped (missing Twilio config or recipient)');
    return { ok: false };
  }
  const body = new URLSearchParams({ From: TWILIO_WHATSAPP_FROM, To: asWhatsApp(to), Body: text });
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`, {
    method: 'POST',
    headers: { Authorization: AUTH_HEADER, 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) console.warn('[whatsapp] send failed:', j.message || res.status);
  return { ok: res.ok, sid: j.sid };
}
