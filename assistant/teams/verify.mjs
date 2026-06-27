// Verify an inbound Bot Framework JWT — the Teams equivalent of Slack's HMAC
// signature check (slack/verify.mjs). Microsoft signs each request with a rotating
// RS256 key; we validate the signature against the published JWKS plus issuer,
// audience, expiry, and the anti-spoofing serviceUrl claim. The key resolver is
// injectable so this security path unit-tests without network.
//
// This is the one spot the project takes a dependency: hand-rolling RSA-over-JWKS
// verification is error-prone and security-critical, so we use jsonwebtoken +
// jwks-rsa (scoped to this file). Everything else in the Teams adapter stays
// hand-rolled over fetch.
//
// Scope: this validates the production Connector->Bot path (issuer
// api.botframework.com). The Bot Framework Emulator's separate issuer and the
// per-signing-key channel "endorsements" check are intentionally NOT implemented —
// this is a production, Teams-only adapter. Revisit if local Emulator auth or
// multi-channel support is added.
import jwt from 'jsonwebtoken';
import { JwksClient } from 'jwks-rsa';

const ISSUER = 'https://api.botframework.com';
const OPENID_CONFIG = 'https://login.botframework.com/v1/.well-known/openidconfiguration';
const CLOCK_SKEW_SEC = 300; // 5-min tolerance, per Bot Framework guidance

// Lazily build a JWKS client from the OpenID metadata's jwks_uri (cached + refreshed
// by jwks-rsa). Memoized per process.
let _jwks;
async function defaultGetKey(header, fetchImpl = fetch) {
  if (!_jwks) {
    const meta = await fetchImpl(OPENID_CONFIG).then((r) => r.json()).catch(() => ({}));
    if (!meta?.jwks_uri) throw new Error('JWKS discovery failed (no jwks_uri)'); // fail closed
    _jwks = new JwksClient({ jwksUri: meta.jwks_uri, cache: true, cacheMaxAge: 24 * 60 * 60 * 1000, rateLimit: true });
  }
  const key = await _jwks.getSigningKey(header.kid);
  return key.getPublicKey();
}

/**
 * Verify the Authorization header of an inbound Teams request. Returns the decoded
 * token payload on success; THROWS on any failure (the caller responds 403).
 * @param appId      our Bot Framework App ID — the required token audience.
 * @param serviceUrl the Activity body's serviceUrl — must equal the token claim.
 * @param getKey     (test seam) async (header) => PEM public key; defaults to JWKS.
 */
export async function verifyTeamsToken({ authHeader, appId, serviceUrl }, { getKey = defaultGetKey, fetchImpl } = {}) {
  const token = /^Bearer\s+(.+)$/i.exec(authHeader || '')?.[1];
  if (!token) throw new Error('missing bearer token');
  // Fail closed on missing config: with an empty audience, jwt.verify SKIPS the aud
  // check, which would accept a valid Microsoft token minted for any other bot.
  if (!appId) throw new Error('MS_APP_ID not configured');
  const decoded = jwt.decode(token, { complete: true });
  if (!decoded?.header) throw new Error('malformed token');
  const pubKey = await getKey(decoded.header, fetchImpl);
  const payload = jwt.verify(token, pubKey, {
    algorithms: ['RS256'],
    issuer: ISSUER,
    audience: appId,
    clockTolerance: CLOCK_SKEW_SEC,
  });
  // Anti-spoofing: when we know the Activity's serviceUrl (the address we POST replies
  // to), the token MUST carry a matching serviceurl claim. The official channel
  // validation requires this unconditionally, so an ABSENT claim is rejected too — no
  // JWT lib checks it, so it's hand-written.
  const claimUrl = payload.serviceurl ?? payload.serviceUrl;
  if (serviceUrl && claimUrl?.replace(/\/$/, '') !== serviceUrl.replace(/\/$/, '')) {
    throw new Error('serviceUrl claim mismatch');
  }
  return payload;
}
