import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { sendActivity } from './connector.mjs';

// Capture outbound calls by stubbing global fetch. NOTE: botToken caches the token in
// module scope, so the first test runs against a cold cache (and thus exercises the
// token request); later tests may reuse it — they only assert the reply URL, which is
// rebuilt per call regardless of the cache.
function withFetch(fn) {
  return async () => {
    const calls = [];
    const real = globalThis.fetch;
    globalThis.fetch = async (url, opts) => {
      calls.push({ url, opts });
      if (url.includes('/oauth2/v2.0/token')) return { ok: true, json: async () => ({ access_token: 'tok', expires_in: 3600 }) };
      return { ok: true, json: async () => ({}) };
    };
    try { await fn(calls); } finally { globalThis.fetch = real; }
  };
}

test('single-tenant token authority + complete reply activity (from=bot, recipient=user, conversation)', withFetch(async (calls) => {
  await sendActivity(
    { serviceUrl: 'https://smba.trafficmanager.net/emea/', conversationId: 'c1', activityId: 'a1',
      from: { id: '28:bot', name: 'Marco' }, recipient: { id: '29:user', name: 'Ana' }, locale: 'it' },
    { text: 'hi' },
    { appId: 'app', appSecret: 'sec', tenantId: 'TENANT-GUID' },
  );
  const tokenCall = calls.find((c) => c.url.includes('/oauth2/v2.0/token'));
  assert.equal(tokenCall.url, 'https://login.microsoftonline.com/TENANT-GUID/oauth2/v2.0/token');
  const replyCall = calls.find((c) => c.url.includes('/v3/conversations/'));
  assert.equal(replyCall.url, 'https://smba.trafficmanager.net/emea/v3/conversations/c1/activities/a1');
  // The body must be a complete Activity, else the Connector returns 400.
  assert.deepEqual(JSON.parse(replyCall.opts.body), {
    type: 'message',
    from: { id: '28:bot', name: 'Marco' },
    recipient: { id: '29:user', name: 'Ana' },
    conversation: { id: 'c1' },
    replyToId: 'a1',
    locale: 'it',
    text: 'hi',
  });
}));

test('reply falls back to send-to-conversation when the inbound has no activity id', withFetch(async (calls) => {
  await sendActivity({ serviceUrl: 'https://smba.trafficmanager.net/emea/', conversationId: 'c2' }, { text: 'hi' }, { appId: 'app', appSecret: 'sec', tenantId: 'T' });
  const replyCall = calls.find((c) => c.url.includes('/v3/conversations/'));
  assert.equal(replyCall.url, 'https://smba.trafficmanager.net/emea/v3/conversations/c2/activities');
  assert.equal(JSON.parse(replyCall.opts.body).replyToId, undefined);
}));
