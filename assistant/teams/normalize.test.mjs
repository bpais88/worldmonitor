import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { normalizeTeamsActivity, shouldRespond } from './normalize.mjs';

test('channel message: strips the <at> mention and maps every id', () => {
  const n = normalizeTeamsActivity({
    type: 'message', id: 'a1',
    text: '<at>Marco</at> which ports are busy?',
    replyToId: 'root1',
    serviceUrl: 'https://smba.trafficmanager.net/emea/',
    from: { id: '29:user', aadObjectId: 'aad-user-9' },
    recipient: { id: '28:app-id' },
    conversation: { id: 'conv-7', conversationType: 'channel' },
    channelData: { tenant: { id: 'tenant-3' } },
    locale: 'en-GB',
  });
  assert.equal(n.tenantId, 'tenant-3');
  assert.equal(n.channelId, 'conv-7');
  assert.equal(n.threadId, 'root1');       // replyToId wins
  assert.equal(n.userId, 'aad-user-9');
  assert.equal(n.text, 'which ports are busy?');
  assert.equal(n.serviceUrl, 'https://smba.trafficmanager.net/emea/');
  assert.equal(n.conversationType, 'channel');
  assert.equal(n.activityId, 'a1');
  // Channel accounts for the reply: from = bot (inbound recipient), recipient = user (inbound from).
  assert.deepEqual(n.botAccount, { id: '28:app-id' });
  assert.deepEqual(n.userAccount, { id: '29:user', aadObjectId: 'aad-user-9' });
  assert.equal(n.locale, 'en-GB');
});

test('personal (1:1) message: threadId falls back to the conversation id', () => {
  const n = normalizeTeamsActivity({
    type: 'message', id: 'a2', text: 'hello',
    from: { aadObjectId: 'u1' }, conversation: { id: 'dm-1', conversationType: 'personal' },
    channelData: { tenant: { id: 't1' } }, serviceUrl: 'https://x/',
  });
  assert.equal(n.threadId, 'dm-1'); // no replyToId → conversation id
  assert.equal(n.text, 'hello');
  assert.equal(n.conversationType, 'personal');
});

test('strips a self-closing <at/> mention as well as the paired form', () => {
  assert.equal(normalizeTeamsActivity({ type: 'message', text: '<at id="0"/> status please', conversation: { id: 'c' } }).text, 'status please');
});

test('shouldRespond: always answers in personal chat', () => {
  assert.equal(shouldRespond({ conversation: { conversationType: 'personal' } }), true);
  assert.equal(shouldRespond({}), true); // default conversationType is personal
});

test('shouldRespond: in a channel only when the bot itself is @mentioned', () => {
  const base = { conversation: { conversationType: 'channel' }, recipient: { id: '28:bot' } };
  assert.equal(shouldRespond(base), false); // no mention
  assert.equal(shouldRespond({ ...base, entities: [{ type: 'mention', mentioned: { id: '28:bot' } }] }), true);
  assert.equal(shouldRespond({ ...base, entities: [{ type: 'mention', mentioned: { id: '28:someone-else' } }] }), false);
});
