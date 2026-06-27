// Verify an inbound Bot Framework JWT — the Teams equivalent of Slack's HMAC
// signature check (slack/verify.mjs). Microsoft signs each request with a rotating
// RS256 key; we validate the signature against the published JWKS plus issuer,
// audience, expiry, and the anti-spoofing serviceUrl claim.
//
// Uses `jose` (ESM-native, ONE dependency) for both the JWKS fetch and the verify:
// createRemoteJWKSet fetches/caches the keys and selects by `kid`; jwtVerify checks
// the signature + iss + aud + exp. We deliberately do NOT use jwks-rsa/jsonwebtoken:
// jwks-rsa is CommonJS and `require()`s jose, but jose is ESM-only — that combination
// crashes under Node ESM (ERR_REQUIRE_ESM, which took prod down). jose imported from
// our ESM modules has no such conflict.
//
// Scope: production Connector->Bot path (issuer api.botframework.com). The Bot
// Framework Emulator's separate issuer and the per-signing-key channel "endorsements"
// check are intentionally NOT implemented — this is a production, Teams-only adapter.
import { createRemoteJWKSet, jwtVerify } from 'jose';

const ISSUER = 'https://api.botframework.com';
const OPENID_CONFIG = 'https://login.botframework.com/v1/.well-known/openidconfiguration';
const CLOCK_SKEW_SEC = 300; // 5-min tolerance, per Bot Framework guidance

// Lazily build the remote key set from the OpenID metadata's jwks_uri. createRemoteJWKSet
// fetches, caches, and refreshes the JWKS and selects the signing key by the token kid.
let _jwks;
async function defaultKeySet(fetchImpl = fetch) {
  if (!_jwks) {
    const meta = await fetchImpl(OPENID_CONFIG).then((r) => r.json()).catch(() => ({}));
    if (!meta?.jwks_uri) throw new Error('JWKS discovery failed (no jwks_uri)'); // fail closed
    _jwks = createRemoteJWKSet(new URL(meta.jwks_uri));
  }
  return _jwks;
}

/**
 * Verify the Authorization header of an inbound Teams request. Returns the decoded
 * token payload on success; THROWS on any failure (the caller responds 403).
 * @param appId      our Bot Framework App ID — the required token audience.
 * @param serviceUrl the Activity body's serviceUrl — must equal the token claim.
 * @param keySet     (test seam) a jose key or JWKS resolver; defaults to the live JWKS.
 */
export async function verifyTeamsToken({ authHeader, appId, serviceUrl }, { keySet, fetchImpl } = {}) {
  const token = /^Bearer\s+(.+)$/i.exec(authHeader || '')?.[1];
  if (!token) throw new Error('missing bearer token');
  // Fail closed on missing config: an empty audience would skip the aud check, which
  // would accept a valid Microsoft token minted for any other bot.
  if (!appId) throw new Error('MS_APP_ID not configured');
  const keys = keySet || await defaultKeySet(fetchImpl);
  const { payload } = await jwtVerify(token, keys, {
    issuer: ISSUER,
    audience: appId,
    algorithms: ['RS256'],
    clockTolerance: CLOCK_SKEW_SEC,
  });
  // Anti-spoofing: serviceUrl (the address we POST replies to) is REQUIRED — both the
  // Activity body value AND the token's serviceurl claim must be present and match. A
  // missing body value or a missing claim is a HARD failure: never skip the check just
  // because a field is absent. No JWT lib checks this; it's Bot Framework specific.
  const claimUrl = payload.serviceurl ?? payload.serviceUrl;
  if (!serviceUrl || !claimUrl || claimUrl.replace(/\/$/, '') !== serviceUrl.replace(/\/$/, '')) {
    throw new Error('serviceUrl missing or claim mismatch');
  }
  return payload;
}
