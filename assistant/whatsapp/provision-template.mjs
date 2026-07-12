// One-time provisioning for the WhatsApp proactive-alert content template (Twilio Content API).
// WhatsApp only delivers business-initiated messages outside the 24h session window through a
// Meta-approved template, so the watch ticker's alerts need one. This registers a single generic
// UTILITY template that carries every watch alert (strike, congestion, vessel delay):
//
//   ⚠️ Marco watch update — {{1}}: {{2}}      ({{1}} = watch target, {{2}} = the alert text)
//
// Usage (same Twilio env as the adapter: TWILIO_ACCOUNT_SID + auth pair):
//   node assistant/whatsapp/provision-template.mjs create          → create + submit for approval, prints the HX… sid
//   node assistant/whatsapp/provision-template.mjs status <HXsid>  → poll the WhatsApp approval verdict
//
// Then set TWILIO_WA_CONTENT_SID=<HXsid> on the assistant service and redeploy. Approval for
// UTILITY templates is usually minutes-to-hours; until it's approved AND the env is set, proactive
// WhatsApp alerts fall back to freeform (delivered only inside a user's 24h session — see connector).
import { twilioAuth, sanitizeTemplateVar } from './connector.mjs';

const TEMPLATE = {
  friendly_name: 'marco_watch_alert_v1',
  language: 'en',
  variables: { 1: 'Genoa', 2: sanitizeTemplateVar('⚠️ Scheduled strike affecting Genoa — starts 2026-07-10 (in 3 days)') },
  types: { 'twilio/text': { body: '⚠️ Marco watch update — {{1}}: {{2}}' } },
};

async function contentApi(path, init) {
  const { accountSid, pass, header } = twilioAuth();
  if (!accountSid || !pass) { console.error('missing Twilio env (TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN or API key pair)'); process.exit(1); }
  const res = await fetch(`https://content.twilio.com/v1${path}`, {
    ...init,
    headers: { Authorization: header, 'Content-Type': 'application/json', ...(init?.headers || {}) },
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) { console.error(`Content API ${path} failed (${res.status}):`, j.message || JSON.stringify(j)); process.exit(1); }
  return j;
}

const [, , cmd, arg] = process.argv;

if (cmd === 'create') {
  const content = await contentApi('/Content', { method: 'POST', body: JSON.stringify(TEMPLATE) });
  console.log(`content created: ${content.sid}`);
  const approval = await contentApi(`/Content/${content.sid}/ApprovalRequests/whatsapp`, {
    method: 'POST',
    body: JSON.stringify({ name: TEMPLATE.friendly_name, category: 'UTILITY' }),
  });
  console.log(`approval submitted (status: ${approval.status || 'pending'})`);
  console.log(`\nnext: node assistant/whatsapp/provision-template.mjs status ${content.sid}`);
  console.log(`then: set TWILIO_WA_CONTENT_SID=${content.sid} on the assistant service + redeploy`);
} else if (cmd === 'status' && arg) {
  const j = await contentApi(`/Content/${arg}/ApprovalRequests`, { method: 'GET' });
  console.log(JSON.stringify(j.whatsapp || j, null, 2));
} else {
  console.log('usage: provision-template.mjs create | status <ContentSid>');
  process.exit(1);
}
