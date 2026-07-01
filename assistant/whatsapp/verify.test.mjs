import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import crypto from 'node:crypto';
import { twilioSignatureBase, verifyTwilioSignature } from './verify.mjs';

const TOKEN = 'test_auth_token';
const URL = 'https://relay.example.com/whatsapp';
const PARAMS = { From: 'whatsapp:+31600000000', Body: 'is rotterdam busy?', To: 'whatsapp:+14155238886', MessageSid: 'SM123' };

// Twilio's signature = base64(HMAC-SHA1(url + params-sorted-by-key as key+value, authToken)).
const sign = (token, url, params) =>
  crypto.createHmac('sha1', token).update(Buffer.from(twilioSignatureBase(url, params), 'utf-8')).digest('base64');

test('twilioSignatureBase = URL + params concatenated sorted by key', () => {
  assert.equal(twilioSignatureBase('https://x/y', { b: '2', a: '1' }), 'https://x/ya1b2');
});

test('verifyTwilioSignature accepts a correct signature', () => {
  const sig = sign(TOKEN, URL, PARAMS);
  assert.equal(verifyTwilioSignature({ authToken: TOKEN, signature: sig, url: URL, params: PARAMS }), true);
});

test('verifyTwilioSignature rejects tampered body / wrong token / wrong url', () => {
  const sig = sign(TOKEN, URL, PARAMS);
  assert.equal(verifyTwilioSignature({ authToken: TOKEN, signature: sig, url: URL, params: { ...PARAMS, Body: 'tampered' } }), false);
  assert.equal(verifyTwilioSignature({ authToken: 'wrong', signature: sig, url: URL, params: PARAMS }), false);
  assert.equal(verifyTwilioSignature({ authToken: TOKEN, signature: sig, url: 'https://evil.example.com/whatsapp', params: PARAMS }), false);
});

test('verifyTwilioSignature fails closed on missing inputs', () => {
  assert.equal(verifyTwilioSignature({ authToken: '', signature: 'x', url: URL, params: PARAMS }), false);
  assert.equal(verifyTwilioSignature({ authToken: TOKEN, signature: '', url: URL, params: PARAMS }), false);
  assert.equal(verifyTwilioSignature({ authToken: TOKEN, signature: 'x', url: '', params: PARAMS }), false);
});
