// Bot Framework Connector client for outbound Teams messages — the Teams send path
// behind send.mjs's `teams` branch. There is no per-tenant token (unlike Slack): one
// global bot credential mints a client-credentials token (cached, refreshed early) used
// to POST activities to the conversation's serviceUrl. Single-tenant bots mint from
// their OWN tenant authority. The conversation reference (serviceUrl + ids) comes from
// the inbound activity today; a stored reference for proactive sends lands in a later PR.
const AUTHORITY = 'https://login.microsoftonline.com';
const SCOPE = 'https://api.botframework.com/.default';
const TOKEN_REFRESH_SKEW_SEC = 300; // refresh slightly before the token actually expires

// Default credentials from env (single-tenant: MS_APP_TENANT_ID set). Threadable so the
// send/token path unit-tests without env.
const ENV_CREDS = {
  appId: process.env.MS_APP_ID || '',
  appSecret: process.env.MS_APP_SECRET || '',
  tenantId: process.env.MS_APP_TENANT_ID || '',
};

let _token = { value: '', expMs: 0 };

async function botToken(creds = ENV_CREDS, now = Date.now()) {
  if (_token.value && now < _token.expMs) return _token.value;
  // Single-tenant bots use their own tenant authority; multi-tenant uses 'botframework.com'.
  const tokenUrl = `${AUTHORITY}/${creds.tenantId || 'botframework.com'}/oauth2/v2.0/token`;
  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: creds.appId, client_secret: creds.appSecret, scope: SCOPE }),
  });
  const j = await res.json().catch(() => ({}));
  if (!j.access_token) throw new Error(`bot token failed: ${j.error || res.status}`);
  _token = { value: j.access_token, expMs: now + ((j.expires_in || 3600) - TOKEN_REFRESH_SKEW_SEC) * 1000 };
  return _token.value;
}

/**
 * Post a message into a Teams conversation. ref = { serviceUrl, conversationId, activityId?,
 * from?, recipient?, locale? }: a threaded reply when activityId is present, otherwise a new
 * message in the conversation (proactive, or channels that omit nested replies). creds
 * default to env (single-tenant).
 *
 * A reply must be a COMPLETE Activity — the Connector does not infer from/recipient/
 * conversation for a raw REST POST, and rejects (HTTP 400) one that omits them. The caller
 * supplies the channel accounts from the inbound activity: outbound `from` = the bot,
 * `recipient` = the user (see Bot Connector "Reply to Activity").
 */
// Mint the bot token and POST/PUT a JSON activity to the Connector, logging the response body
// on a non-2xx. Shared by the send/reply path and the in-place card-update (PUT) path.
async function request(method, url, body, creds) {
  const token = await botToken(creds);
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) console.warn(`[teams] ${method} failed:`, res.status, (await res.text().catch(() => '')).slice(0, 300));
  return res;
}

export async function sendActivity({ serviceUrl, conversationId, activityId, from, recipient, locale }, { text, attachments } = {}, creds = ENV_CREDS) {
  const base = String(serviceUrl || '').replace(/\/$/, '');
  const conv = encodeURIComponent(conversationId);
  const url = activityId
    ? `${base}/v3/conversations/${conv}/activities/${encodeURIComponent(activityId)}`
    : `${base}/v3/conversations/${conv}/activities`;
  // Card-only sends (attachments, no text) avoid Teams "message splitting" so the POST
  // reliably returns the card's activity id (and the click echoes it as replyToId anyway).
  const activity = {
    type: 'message',
    ...(from ? { from } : {}),
    ...(recipient ? { recipient } : {}),
    ...(conversationId ? { conversation: { id: conversationId } } : {}),
    ...(activityId ? { replyToId: activityId } : {}),
    ...(locale ? { locale } : {}),
    ...(text != null ? { text } : {}),
    ...(attachments ? { attachments } : {}),
  };
  return request('POST', url, activity, creds);
}

/**
 * Replace a message the bot previously sent — used to resolve an Adaptive Card in place after
 * an Approve/Reject. PUT to the activity; the path identifies the target, so (unlike a send)
 * from/recipient/conversation are NOT required in the body. activityId = the card message's id
 * (the Action.Submit click carries it as `replyToId`).
 */
export async function updateActivity({ serviceUrl, conversationId, activityId }, { text, attachments } = {}, creds = ENV_CREDS) {
  const base = String(serviceUrl || '').replace(/\/$/, '');
  const url = `${base}/v3/conversations/${encodeURIComponent(conversationId)}/activities/${encodeURIComponent(activityId)}`;
  return request('PUT', url, { type: 'message', ...(text != null ? { text } : {}), ...(attachments ? { attachments } : {}) }, creds);
}
