// Minimal Bot Framework Connector client for outbound replies — the Teams send
// path. There is no per-tenant token (unlike Slack): one global bot credential
// mints a client-credentials token, cached and refreshed early, used to POST
// activities to the conversation's serviceUrl. This is enough to reply to an
// inbound activity; the fuller send/update + conversation-reference reuse (for
// proactive watch alerts) lands with the agent wiring in a later PR.
const AUTHORITY = 'https://login.microsoftonline.com';
const SCOPE = 'https://api.botframework.com/.default';
const TOKEN_REFRESH_SKEW_SEC = 300; // refresh slightly before the token actually expires

let _token = { value: '', expMs: 0 };

// Single-tenant bots must mint the Connector token from their OWN Azure AD tenant's
// authority; only multi-tenant bots use the shared 'botframework.com' authority. Pass
// tenantId (the app's tenant id, via MS_APP_TENANT_ID) for single-tenant — which is how
// this bot is registered — and omit it for multi-tenant.
async function botToken({ appId, appSecret, tenantId }, now = Date.now()) {
  if (_token.value && now < _token.expMs) return _token.value;
  const tokenUrl = `${AUTHORITY}/${tenantId || 'botframework.com'}/oauth2/v2.0/token`;
  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: appId, client_secret: appSecret, scope: SCOPE }),
  });
  const j = await res.json().catch(() => ({}));
  if (!j.access_token) throw new Error(`bot token failed: ${j.error || res.status}`);
  _token = { value: j.access_token, expMs: now + ((j.expires_in || 3600) - TOKEN_REFRESH_SKEW_SEC) * 1000 };
  return _token.value;
}

/** Reply to an inbound activity in the same conversation/thread. */
export async function replyToActivity(inbound, text, creds) {
  const token = await botToken(creds);
  const base = String(inbound.serviceUrl || '').replace(/\/$/, '');
  const convId = encodeURIComponent(inbound.conversation.id);
  // Reply-to-activity when we have an inbound activity id; otherwise fall back to
  // send-to-conversation (channels without nested replies may omit the id).
  const url = inbound.id
    ? `${base}/v3/conversations/${convId}/activities/${encodeURIComponent(inbound.id)}`
    : `${base}/v3/conversations/${convId}/activities`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ type: 'message', text, ...(inbound.id ? { replyToId: inbound.id } : {}) }),
  });
  if (!res.ok) console.warn('[teams] reply failed:', res.status);
  return res;
}
