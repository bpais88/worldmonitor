import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  recordTeamsConversation, getTeamsInstall, listTeamsInstalls, removeTeamsInstall, markTeamsOnboarded,
} from './installations.mjs';

// Runs against store.mjs's in-memory KV fallback (no Upstash creds in test).
// Distinct conversation ids per test so the shared in-memory store can't cross-talk.

const DELIVER = { serviceUrl: 'https://smba/', from: { id: '28:bot' }, recipient: { id: '29:user' }, locale: 'it' };

test('records a conversation reference with the opaque send.mjs deliver handle', async () => {
  const rec = await recordTeamsConversation({
    conversationId: 'conv-A', tenantId: 'tnt-1', conversationType: 'personal', deliver: DELIVER,
  });
  assert.equal(rec.platform, 'teams');
  assert.equal(rec.onboarded, false);
  assert.deepEqual(rec.deliver, DELIVER); // stored opaquely, not re-shaped
  const got = await getTeamsInstall('conv-A');
  assert.equal(got.conversationId, 'conv-A');
  assert.equal(got.tenantId, 'tnt-1');
});

test('upsert preserves the onboarded flag across re-records (idempotent greeting)', async () => {
  const first = await recordTeamsConversation({ conversationId: 'conv-B', conversationType: 'personal', deliver: DELIVER });
  await markTeamsOnboarded(first);
  // A later conversationUpdate re-records the same conversation — must NOT reset onboarded.
  const rec = await recordTeamsConversation({ conversationId: 'conv-B', conversationType: 'personal', deliver: DELIVER });
  assert.equal(rec.onboarded, true);
});

test('markTeamsOnboarded returns null for a record without a conversationId', async () => {
  assert.equal(await markTeamsOnboarded(null), null);
  assert.equal(await markTeamsOnboarded({}), null);
});

test('list returns saved installs; remove deletes', async () => {
  await recordTeamsConversation({ conversationId: 'conv-C', conversationType: 'channel', deliver: DELIVER });
  assert.ok((await listTeamsInstalls()).map((r) => r.conversationId).includes('conv-C'));
  await removeTeamsInstall('conv-C');
  assert.ok(!(await listTeamsInstalls()).map((r) => r.conversationId).includes('conv-C'));
});

test('recordTeamsConversation requires a conversationId', async () => {
  await assert.rejects(() => recordTeamsConversation({ conversationType: 'personal' }), /conversationId required/);
});
