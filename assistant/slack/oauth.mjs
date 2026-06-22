// Slack OAuth v2 install flow — the "Add to Slack" mechanics. authorizeUrl()
// builds the consent link; exchangeCode() trades the returned code for that
// workspace's bot token. Keeping these pure (authorizeUrl) / thin (exchangeCode)
// makes the install route in server.mjs small and testable.
import crypto from 'node:crypto';
import { kvGet, kvSet, kvDel } from '../store.mjs';

// Minimal scopes Marco needs: hear @mentions + DMs, reply, open DMs (onboarding),
// read user/team names. Add scopes here as tools grow (one re-install picks them up).
export const SCOPES = [
  'app_mentions:read',
  'chat:write',
  'im:history',
  'im:write',
  'users:read',
  'team:read',
];

/** Build the Slack consent URL the "Add to Slack" button points at. */
export function authorizeUrl({ clientId, redirectUri, state, scopes = SCOPES }) {
  if (!clientId) throw new Error('authorizeUrl: clientId required');
  const q = new URLSearchParams({
    client_id: clientId,
    scope: scopes.join(','),
    redirect_uri: redirectUri,
    state,
  });
  return `https://slack.com/oauth/v2/authorize?${q.toString()}`;
}

/** Exchange the OAuth code for a bot token. Returns a normalized installation. */
export async function exchangeCode({ clientId, clientSecret, code, redirectUri, fetchImpl = fetch }) {
  const res = await fetchImpl('https://slack.com/api/oauth.v2.access', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri }),
  });
  const j = await res.json().catch(() => ({}));
  if (!j.ok) throw new Error(`oauth.v2.access failed: ${j.error || res.status}`);
  return {
    teamId: j.team?.id,
    teamName: j.team?.name || '',
    botToken: j.access_token,
    botUserId: j.bot_user_id,
    installedBy: j.authed_user?.id || '',
    installedAt: new Date().toISOString(),
  };
}

// Short-lived single-use CSRF state for the OAuth round-trip. Stored in the shared
// KV (not process memory) so the /install and /callback halves can land on
// different Railway replicas.
const STATE_TTL_SEC = 10 * 60;
const stateKey = (s) => `oauthstate:${s}`;

export async function newState() {
  const state = crypto.randomBytes(16).toString('hex');
  await kvSet(stateKey(state), 1, STATE_TTL_SEC);
  return state;
}

export async function consumeState(state) {
  if (!state) return false;
  const v = await kvGet(stateKey(state)); // null once expired (Redis EX)
  if (v == null) return false;
  await kvDel(stateKey(state));
  return true;
}
