import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { SignJWT, generateKeyPair } from 'jose';
import { verifyTeamsToken } from './verify.mjs';

// Test seam: a self-generated RS256 keypair stands in for Microsoft's JWKS, so the
// signature/issuer/audience/expiry/serviceUrl path is exercised without network. jose's
// jwtVerify accepts a key directly as the second arg, so we pass the public key.
const { publicKey, privateKey } = await generateKeyPair('RS256');
const keySet = publicKey;

const APP_ID = 'my-app-id';
const ISSUER = 'https://api.botframework.com';
const SERVICE_URL = 'https://smba.trafficmanager.net/emea/';

// Build a signed token, with overrides for the negative cases.
async function sign({ claims = {}, iss = ISSUER, aud = APP_ID, expSec = 3600, alg = 'RS256', key = privateKey } = {}) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ serviceurl: SERVICE_URL, ...claims })
    .setProtectedHeader({ alg })
    .setIssuer(iss)
    .setAudience(aud)
    .setIssuedAt(now)
    .setExpirationTime(now + expSec)
    .sign(key);
}

const verify = (token) =>
  verifyTeamsToken({ authHeader: `Bearer ${token}`, appId: APP_ID, serviceUrl: SERVICE_URL }, { keySet });

test('accepts a well-formed Bot Framework token', async () => {
  const payload = await verify(await sign());
  assert.equal(payload.iss, ISSUER);
  assert.equal(payload.aud, APP_ID);
});

test('rejects a missing Authorization header', async () => {
  await assert.rejects(() => verifyTeamsToken({ authHeader: '', appId: APP_ID, serviceUrl: SERVICE_URL }, { keySet }), /missing bearer/i);
});

test('fails closed when MS_APP_ID (appId) is not configured', async () => {
  await assert.rejects(async () => verifyTeamsToken({ authHeader: `Bearer ${await sign()}`, appId: '', serviceUrl: SERVICE_URL }, { keySet }), /MS_APP_ID/i);
});

test('rejects a wrong audience (token minted for another bot)', async () => {
  await assert.rejects(async () => verify(await sign({ aud: 'other-app' })), /aud/i);
});

test('rejects a wrong issuer', async () => {
  await assert.rejects(async () => verify(await sign({ iss: 'https://evil.example' })), /iss/i);
});

test('rejects an expired token (beyond the 5-min skew)', async () => {
  await assert.rejects(async () => verify(await sign({ expSec: -3600 })), /exp|timestamp/i);
});

test('rejects a serviceUrl claim that does not match the activity (anti-spoof)', async () => {
  await assert.rejects(async () => verify(await sign({ claims: { serviceurl: 'https://attacker.example/' } })), /serviceurl/i);
});

test('rejects a token missing the serviceurl claim (anti-spoof requires it)', async () => {
  const now = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({}) // no serviceurl
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuer(ISSUER).setAudience(APP_ID).setIssuedAt(now).setExpirationTime(now + 3600)
    .sign(privateKey);
  await assert.rejects(() => verify(token), /serviceurl/i);
});

test('rejects a token signed by the wrong key', async () => {
  const other = await generateKeyPair('RS256');
  await assert.rejects(async () => verify(await sign({ key: other.privateKey })), /signature/i);
});

test('rejects an alg:none / unsigned token (algorithm confusion)', async () => {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = `${b64({ alg: 'none' })}.${b64({ iss: ISSUER, aud: APP_ID, serviceurl: SERVICE_URL })}.`;
  await assert.rejects(() => verify(unsigned), /alg|signature|jws|unsecured/i);
});

test('rejects an HS256 token (only RS256 is allowed)', async () => {
  const now = Math.floor(Date.now() / 1000);
  const secret = new TextEncoder().encode('a-shared-secret-pretending-to-be-a-key');
  const token = await new SignJWT({ serviceurl: SERVICE_URL })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(ISSUER).setAudience(APP_ID).setIssuedAt(now).setExpirationTime(now + 3600)
    .sign(secret);
  await assert.rejects(() => verify(token), /alg/i);
});
