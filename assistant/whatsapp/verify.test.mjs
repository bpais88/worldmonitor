import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { verifyWebhookBasicAuth, WEBHOOK_USER } from './verify.mjs';

const SECRET = 'super-secret-webhook-pass';
const basic = (user, pass) => `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;

test('accepts the correct Basic credential', () => {
  assert.equal(
    verifyWebhookBasicAuth({ header: basic(WEBHOOK_USER, SECRET), expectedSecret: SECRET }),
    true,
  );
});

test('rejects a wrong password or wrong username', () => {
  assert.equal(verifyWebhookBasicAuth({ header: basic(WEBHOOK_USER, 'nope'), expectedSecret: SECRET }), false);
  assert.equal(verifyWebhookBasicAuth({ header: basic('attacker', SECRET), expectedSecret: SECRET }), false);
});

test('rejects malformed / non-Basic headers', () => {
  assert.equal(verifyWebhookBasicAuth({ header: `Bearer ${SECRET}`, expectedSecret: SECRET }), false);
  assert.equal(verifyWebhookBasicAuth({ header: 'Basic !!!not-base64', expectedSecret: SECRET }), false);
  assert.equal(verifyWebhookBasicAuth({ header: `Basic ${Buffer.from('nocolon').toString('base64')}`, expectedSecret: SECRET }), false);
});

test('fails closed on missing secret or header', () => {
  assert.equal(verifyWebhookBasicAuth({ header: basic(WEBHOOK_USER, SECRET), expectedSecret: '' }), false);
  assert.equal(verifyWebhookBasicAuth({ header: '', expectedSecret: SECRET }), false);
});
