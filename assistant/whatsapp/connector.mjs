// Twilio WhatsApp send — the outbound half of the WhatsApp adapter. Posts to the Twilio
// Messages API (Basic auth = AccountSid:AuthToken). No `twilio` dependency — mirrors how
// teams/connector.mjs owns the Teams wire calls. Reached only through send.mjs's whatsapp branch.

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || '';
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || '';
// The WhatsApp sender, e.g. "whatsapp:+14155238886" (the Twilio sandbox or your approved sender).
const TWILIO_WHATSAPP_FROM = process.env.TWILIO_WHATSAPP_FROM || '';

const asWhatsApp = (n) => (n.startsWith('whatsapp:') ? n : `whatsapp:${n}`);

export async function sendWhatsApp({ to, text }) {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_WHATSAPP_FROM || !to) {
    console.warn('[whatsapp] send skipped (missing Twilio config or recipient)');
    return { ok: false };
  }
  const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64');
  const body = new URLSearchParams({ From: TWILIO_WHATSAPP_FROM, To: asWhatsApp(to), Body: text });
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) console.warn('[whatsapp] send failed:', j.message || res.status);
  return { ok: res.ok, sid: j.sid };
}
