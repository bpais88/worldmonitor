import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { verifyTeamsToken } from './verify.mjs';

// Test seam: a self-generated RSA keypair stands in for Microsoft's JWKS, so the
// signature/issuer/audience/expiry/serviceUrl path is exercised without network.
const kp = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = kp.publicKey.export({ type: 'spki', format: 'pem' });
const PRIV = kp.privateKey.export({ type: 'pkcs8', format: 'pem' });
const getKey = async () => PEM;

const APP_ID = 'my-app-id';
const ISSUER = 'https://api.botframework.com';
const SERVICE_URL = 'https://smba.trafficmanager.net/emea/';

const sign = (claims = {}, opts = {}) =>
  jwt.sign({ serviceurl: SERVICE_URL, ...claims }, PRIV, { algorithm: 'RS256', issuer: ISSUER, audience: APP_ID, expiresIn: '1h', ...opts });

const verify = (token) =>
  verifyTeamsToken({ authHeader: `Bearer ${token}`, appId: APP_ID, serviceUrl: SERVICE_URL }, { getKey });

test('accepts a well-formed Bot Framework token', async () => {
  const payload = await verify(sign());
  assert.equal(payload.iss, ISSUER);
  assert.equal(payload.aud, APP_ID);
});

test('rejects a missing Authorization header', async () => {
  await assert.rejects(() => verifyTeamsToken({ authHeader: '', appId: APP_ID, serviceUrl: SERVICE_URL }, { getKey }), /missing bearer/i);
});

test('rejects a wrong audience (token minted for another bot)', async () => {
  await assert.rejects(() => verify(sign({}, { audience: 'other-app' })), /audience/i);
});

test('rejects a wrong issuer', async () => {
  await assert.rejects(() => verify(sign({}, { issuer: 'https://evil.example' })), /issuer/i);
});

test('rejects an expired token (beyond the 5-min skew)', async () => {
  await assert.rejects(() => verify(sign({}, { expiresIn: -3600 })), /expired/i);
});

test('rejects a serviceUrl claim that does not match the activity (anti-spoof)', async () => {
  await assert.rejects(() => verify(sign({ serviceurl: 'https://attacker.example/' })), /serviceUrl/i);
});

test('rejects a token signed by the wrong key', async () => {
  const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const token = jwt.sign({ serviceurl: SERVICE_URL }, other.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    { algorithm: 'RS256', issuer: ISSUER, audience: APP_ID, expiresIn: '1h' });
  await assert.rejects(() => verify(token), /signature/i);
});

test('fails closed when MS_APP_ID (appId) is not configured', async () => {
  await assert.rejects(
    () => verifyTeamsToken({ authHeader: `Bearer ${sign()}`, appId: '', serviceUrl: SERVICE_URL }, { getKey }),
    /MS_APP_ID/i,
  );
});

test('rejects an alg:none token (algorithm confusion)', async () => {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const forged = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ iss: ISSUER, aud: APP_ID, serviceurl: SERVICE_URL })}.`;
  await assert.rejects(() => verify(forged), /signature|algorithm|invalid/i);
});

test('rejects an HS256 token forged with the public key as the HMAC secret', async () => {
  const forged = jwt.sign({ serviceurl: SERVICE_URL }, PEM,
    { algorithm: 'HS256', issuer: ISSUER, audience: APP_ID, expiresIn: '1h' });
  await assert.rejects(() => verify(forged), /algorithm/i);
});

test('rejects a token missing the serviceurl claim (anti-spoof requires it)', async () => {
  const noClaim = jwt.sign({}, PRIV, { algorithm: 'RS256', issuer: ISSUER, audience: APP_ID, expiresIn: '1h' });
  await assert.rejects(() => verify(noClaim), /serviceUrl/i);
});
