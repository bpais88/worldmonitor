import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { verifyTelegramSecret } from './verify.mjs';

const SECRET = 'tg-webhook-secret-token';

test('accepts the matching secret token', () => {
  assert.equal(verifyTelegramSecret({ provided: SECRET, expected: SECRET }), true);
});

test('rejects a wrong or truncated token', () => {
  assert.equal(verifyTelegramSecret({ provided: 'nope', expected: SECRET }), false);
  assert.equal(verifyTelegramSecret({ provided: SECRET.slice(0, -1), expected: SECRET }), false);
});

test('fails closed on missing secret or missing header', () => {
  assert.equal(verifyTelegramSecret({ provided: SECRET, expected: '' }), false);
  assert.equal(verifyTelegramSecret({ provided: '', expected: SECRET }), false);
  assert.equal(verifyTelegramSecret({ provided: undefined, expected: SECRET }), false);
});
