import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { replyToActivity } from './connector.mjs';

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

test('single-tenant: mints the Connector token from the app tenant authority (not botframework.com)', withFetch(async (calls) => {
  const inbound = { serviceUrl: 'https://smba.trafficmanager.net/emea/', conversation: { id: 'c1' }, id: 'a1' };
  await replyToActivity(inbound, 'hi', { appId: 'app', appSecret: 'sec', tenantId: 'TENANT-GUID' });
  const tokenCall = calls.find((c) => c.url.includes('/oauth2/v2.0/token'));
  assert.equal(tokenCall.url, 'https://login.microsoftonline.com/TENANT-GUID/oauth2/v2.0/token');
  const replyCall = calls.find((c) => c.url.includes('/v3/conversations/'));
  assert.equal(replyCall.url, 'https://smba.trafficmanager.net/emea/v3/conversations/c1/activities/a1');
  assert.deepEqual(JSON.parse(replyCall.opts.body), { type: 'message', text: 'hi', replyToId: 'a1' });
}));

test('reply falls back to send-to-conversation when the inbound has no activity id', withFetch(async (calls) => {
  const inbound = { serviceUrl: 'https://smba.trafficmanager.net/emea/', conversation: { id: 'c2' } }; // no id
  await replyToActivity(inbound, 'hi', { appId: 'app', appSecret: 'sec', tenantId: 'T' });
  const replyCall = calls.find((c) => c.url.includes('/v3/conversations/'));
  assert.equal(replyCall.url, 'https://smba.trafficmanager.net/emea/v3/conversations/c2/activities');
  assert.equal(JSON.parse(replyCall.opts.body).replyToId, undefined);
}));
