import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { verifyWebhookSecret } from './verify.mjs';

const SECRET = 'super-secret-webhook-pass';

test('accepts the matching secret', () => {
  assert.equal(verifyWebhookSecret({ provided: SECRET, expected: SECRET }), true);
});

test('rejects a wrong or truncated secret', () => {
  assert.equal(verifyWebhookSecret({ provided: 'nope', expected: SECRET }), false);
  assert.equal(verifyWebhookSecret({ provided: SECRET.slice(0, -1), expected: SECRET }), false);
});

test('fails closed on missing secret or missing param', () => {
  assert.equal(verifyWebhookSecret({ provided: SECRET, expected: '' }), false);
  assert.equal(verifyWebhookSecret({ provided: '', expected: SECRET }), false);
  assert.equal(verifyWebhookSecret({ provided: null, expected: SECRET }), false);
  assert.equal(verifyWebhookSecret({ provided: undefined, expected: SECRET }), false);
});
