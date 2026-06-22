import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import crypto from 'node:crypto';
import { policyForUser, parseActionUsers } from './permissions.mjs';
import { verifySlackSignature } from './verify.mjs';
import { putPending, peekPending, takePending } from './pending.mjs';

// --- permissions ---------------------------------------------------------
test('allowlisted user can execute actions', () => {
  const p = policyForUser('U_ADMIN', { actionUsers: 'U_ADMIN,U_OTHER' });
  assert.equal(p.allowActions, true);
  assert.equal(p.execute, true);
});

test('non-allowlisted user is read-only by default', () => {
  const p = policyForUser('U_GUEST', { actionUsers: 'U_ADMIN' });
  assert.equal(p.allowActions, false);
  assert.equal(p.execute, false);
});

test('non-allowlisted user may dry-run when allowDryRunForAll', () => {
  const p = policyForUser('U_GUEST', { actionUsers: 'U_ADMIN', allowDryRunForAll: true });
  assert.equal(p.allowActions, true);
  assert.equal(p.execute, false);
});

test('parseActionUsers handles commas and whitespace', () => {
  assert.deepEqual([...parseActionUsers('U1, U2  U3')].sort(), ['U1', 'U2', 'U3']);
  assert.equal(parseActionUsers('').size, 0);
});

// --- signature verification ---------------------------------------------
function sign(secret, ts, body) {
  return 'v0=' + crypto.createHmac('sha256', secret).update(`v0:${ts}:${body}`).digest('hex');
}

test('verifySlackSignature accepts a valid, fresh signature', () => {
  const secret = 'shhh';
  const ts = Math.floor(Date.now() / 1000);
  const body = '{"type":"event_callback"}';
  assert.equal(verifySlackSignature({ signingSecret: secret, signature: sign(secret, ts, body), timestamp: ts, body }), true);
});

test('verifySlackSignature rejects a tampered body', () => {
  const secret = 'shhh';
  const ts = Math.floor(Date.now() / 1000);
  const good = sign(secret, ts, '{"a":1}');
  assert.equal(verifySlackSignature({ signingSecret: secret, signature: good, timestamp: ts, body: '{"a":2}' }), false);
});

test('verifySlackSignature rejects a stale timestamp (replay)', () => {
  const secret = 'shhh';
  const ts = Math.floor(Date.now() / 1000) - 60 * 10; // 10 min old
  const body = '{}';
  assert.equal(verifySlackSignature({ signingSecret: secret, signature: sign(secret, ts, body), timestamp: ts, body }), false);
});

test('verifySlackSignature rejects when secret/headers missing', () => {
  assert.equal(verifySlackSignature({ signingSecret: '', signature: 'x', timestamp: '1', body: '{}' }), false);
  assert.equal(verifySlackSignature({ signingSecret: 's', signature: '', timestamp: '1', body: '{}' }), false);
});

// --- pending action store (approval flow) -------------------------------
test('putPending/takePending round-trips an action once', () => {
  const id = putPending({ tool: 'save_freight_report', input: { filename: 'x' } });
  assert.equal(peekPending(id).tool, 'save_freight_report'); // peek doesn't consume
  const taken = takePending(id);
  assert.equal(taken.input.filename, 'x');
  assert.equal(takePending(id), null); // already consumed
});

test('peekPending returns null for unknown / expired ids', () => {
  assert.equal(peekPending('nope'), null);
  const id = putPending({ tool: 't', input: {} }, 1_000);
  assert.equal(peekPending(id, 1_000 + 31 * 60 * 1000), null); // past 30-min TTL
});
