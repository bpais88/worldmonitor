// Minimal Bot Framework Connector client for outbound replies — the Teams send
// path. There is no per-tenant token (unlike Slack): one global bot credential
// mints a client-credentials token, cached and refreshed early, used to POST
// activities to the conversation's serviceUrl. This is enough to reply to an
// inbound activity; the fuller send/update + conversation-reference reuse (for
// proactive watch alerts) lands with the agent wiring in a later PR.
const TOKEN_URL = 'https://login.microsoftonline.com/botframework.com/oauth2/v2.0/token';
const SCOPE = 'https://api.botframework.com/.default';

let _token = { value: '', expMs: 0 };

async function botToken({ appId, appSecret }, now = Date.now()) {
  if (_token.value && now < _token.expMs) return _token.value;
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: appId, client_secret: appSecret, scope: SCOPE }),
  });
  const j = await res.json().catch(() => ({}));
  if (!j.access_token) throw new Error(`bot token failed: ${j.error || res.status}`);
  _token = { value: j.access_token, expMs: now + ((j.expires_in || 3600) - 300) * 1000 };
  return _token.value;
}

/** Reply to an inbound activity in the same conversation/thread. */
export async function replyToActivity(inbound, text, creds) {
  const token = await botToken(creds);
  const base = String(inbound.serviceUrl || '').replace(/\/$/, '');
  const url = `${base}/v3/conversations/${encodeURIComponent(inbound.conversation.id)}/activities/${encodeURIComponent(inbound.id)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ type: 'message', text, replyToId: inbound.id }),
  });
  if (!res.ok) console.warn('[teams] reply failed:', res.status);
  return res;
}
