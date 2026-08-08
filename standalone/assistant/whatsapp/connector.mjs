// Twilio WhatsApp send — the outbound half of the WhatsApp adapter. Posts to the Twilio
// Messages API (Basic auth = ApiKeySid:ApiKeySecret, or AccountSid:AuthToken as a fallback).
// No `twilio` dependency — mirrors how teams/connector.mjs owns the Teams wire calls. Reached
// only through send.mjs's whatsapp branch.
//
// Two message shapes:
//   - Freeform `Body`: reactive replies, always inside WhatsApp's 24h customer-service window.
//   - Content template (`ContentSid` + `ContentVariables`): proactive watch alerts, which fire at
//     any time — outside the 24h window WhatsApp delivers business-initiated messages ONLY via a
//     pre-approved template. Create + approve one with provision-template.mjs, then set
//     TWILIO_WA_CONTENT_SID. If the SID is missing, a template send falls back to freeform:
//     delivered inside the window, dropped by WhatsApp outside it (error 63016) — degraded but
//     loudly logged, never silent.

const asWhatsApp = (n) => (n.startsWith('whatsapp:') ? n : `whatsapp:${n}`);

// Env read per call (not hoisted): costs nothing at this call rate and lets tests set/clear the
// Twilio vars around a single send. REST auth: prefer a scoped API key (SK…:secret) over the
// account-wide Auth Token; either pair is valid Basic auth (the URL still addresses the account
// SID). Select the pair ATOMICALLY — a half-set API key must not borrow the Auth Token as its
// password, which would form a mismatched pair Twilio 401s while slipping past the local guard.
export function twilioAuth() {
  const accountSid = process.env.TWILIO_ACCOUNT_SID || '';
  const [user, pass] = process.env.TWILIO_API_KEY_SID
    ? [process.env.TWILIO_API_KEY_SID, process.env.TWILIO_API_KEY_SECRET || '']
    : [accountSid, process.env.TWILIO_AUTH_TOKEN || ''];
  return { accountSid, pass, header: `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}` };
}

// WhatsApp rejects template variable values containing newlines/tabs (and collapses long runs of
// spaces); alert prose is multi-line, so joins become an em-dash. Exported for the provision
// script's sample values and for tests.
export const sanitizeTemplateVar = (s) => String(s ?? '').replace(/\s*[\r\n\t]+\s*/g, ' — ').replace(/ {4,}/g, ' ').trim();

/**
 * Send one WhatsApp message. `template` (optional) = { variables: {1: ..., 2: ...} } — used with
 * the approved content template TWILIO_WA_CONTENT_SID for proactive sends; omitted for reactive
 * replies (freeform is always deliverable there: we're inside the user's 24h session by definition).
 */
export async function sendWhatsApp({ to, text, template }) {
  const { accountSid, pass, header } = twilioAuth();
  const from = process.env.TWILIO_WHATSAPP_FROM || ''; // e.g. "whatsapp:+14155238886"
  if (!accountSid || !pass || !from || !to) {
    console.warn('[whatsapp] send skipped (missing Twilio config or recipient)');
    return { ok: false };
  }
  const body = new URLSearchParams({ From: from, To: asWhatsApp(to) });
  const contentSid = process.env.TWILIO_WA_CONTENT_SID || '';
  if (template && contentSid) {
    body.set('ContentSid', contentSid);
    body.set('ContentVariables', JSON.stringify(Object.fromEntries(
      Object.entries(template.variables || {}).map(([k, v]) => [k, sanitizeTemplateVar(v)]),
    )));
  } else {
    if (template) console.warn('[whatsapp] TWILIO_WA_CONTENT_SID unset — proactive alert sent freeform (WhatsApp drops it outside the 24h session window; run whatsapp/provision-template.mjs)');
    body.set('Body', text);
  }
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
    method: 'POST',
    headers: { Authorization: header, 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) console.warn('[whatsapp] send failed:', j.message || res.status);
  return { ok: res.ok, sid: j.sid };
}
