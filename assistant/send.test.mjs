import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { send, update, dm, deliverFor } from './send.mjs';

// Capture outgoing Slack Web API calls by stubbing global fetch, so we can assert
// the platform-neutral layer produces byte-identical payloads to the old inline code.
function withFetch(fn) {
  return async () => {
    const calls = [];
    const real = globalThis.fetch;
    globalThis.fetch = async (url, opts) => {
      calls.push({ url, body: JSON.parse(opts.body), auth: opts.headers.Authorization });
      return { json: async () => ({ ok: true, ts: '111.222', channel: { id: 'D1' } }) };
    };
    try { await fn(calls); } finally { globalThis.fetch = real; }
  };
}

test('deliverFor resolves deliver, falls back to legacy botToken, else null', () => {
  assert.equal(deliverFor({ platform: 'slack', deliver: 'xoxb-new' }), 'xoxb-new');
  assert.equal(deliverFor({ botToken: 'xoxb-legacy' }), 'xoxb-legacy'); // pre-generalization record
  assert.equal(deliverFor(null), null);
});

test('send → chat.postMessage, same payload as the old inline post()', withFetch(async (calls) => {
  await send({ platform: 'slack', deliver: 'xoxb-1' }, { channelId: 'C9', threadId: 'T9', text: 'hi' });
  assert.equal(calls[0].url, 'https://slack.com/api/chat.postMessage');
  assert.equal(calls[0].auth, 'Bearer xoxb-1');
  assert.deepEqual(calls[0].body, { channel: 'C9', thread_ts: 'T9', text: 'hi', unfurl_links: false });
}));

test('send passes approval-card blocks through unchanged', withFetch(async (calls) => {
  const blocks = [{ type: 'section', text: { type: 'mrkdwn', text: 'x' } }];
  await send({ platform: 'slack', deliver: 'xoxb-1' }, { channelId: 'C', threadId: 'T', text: 'x', blocks });
  assert.deepEqual(calls[0].body.blocks, blocks);
}));

test('update → chat.update wrapping text in a single mrkdwn section', withFetch(async (calls) => {
  await update({ platform: 'slack', deliver: 'xoxb-1' }, { channelId: 'C', messageId: '111.222', text: 'done' });
  assert.equal(calls[0].url, 'https://slack.com/api/chat.update');
  assert.deepEqual(calls[0].body, { channel: 'C', ts: '111.222', text: 'done', blocks: [{ type: 'section', text: { type: 'mrkdwn', text: 'done' } }] });
}));

test('dm → conversations.open then chat.postMessage to the opened channel', withFetch(async (calls) => {
  await dm({ platform: 'slack', deliver: 'xoxb-1' }, { userId: 'U7', text: 'ciao' });
  assert.equal(calls[0].url, 'https://slack.com/api/conversations.open');
  assert.deepEqual(calls[0].body, { users: 'U7' });
  assert.equal(calls[1].url, 'https://slack.com/api/chat.postMessage');
  assert.deepEqual(calls[1].body, { channel: 'D1', text: 'ciao', unfurl_links: false });
}));

test('legacy botToken-only install still delivers (uses botToken as the bearer)', withFetch(async (calls) => {
  await send({ botToken: 'xoxb-legacy' }, { channelId: 'C', threadId: 'T', text: 'x' });
  assert.equal(calls[0].auth, 'Bearer xoxb-legacy');
}));

test('teams platform throws until the Teams adapter is wired (PR1 is Slack-only)', async () => {
  await assert.rejects(() => send({ platform: 'teams', deliver: {} }, { channelId: 'c', text: 't' }), /teams delivery not wired/);
  await assert.rejects(() => update({ platform: 'teams' }, { channelId: 'c', messageId: 'm', text: 't' }), /teams delivery not wired/);
  await assert.rejects(() => dm({ platform: 'teams' }, { userId: 'u', text: 't' }), /teams delivery not wired/);
});
