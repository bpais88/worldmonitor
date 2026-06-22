import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { authorizeUrl, exchangeCode, newState, consumeState, SCOPES } from './oauth.mjs';

test('authorizeUrl includes client_id, scopes, redirect, state', () => {
  const url = authorizeUrl({ clientId: 'CID', redirectUri: 'https://x/cb', state: 'st' });
  const u = new URL(url);
  assert.equal(u.origin + u.pathname, 'https://slack.com/oauth/v2/authorize');
  assert.equal(u.searchParams.get('client_id'), 'CID');
  assert.equal(u.searchParams.get('redirect_uri'), 'https://x/cb');
  assert.equal(u.searchParams.get('state'), 'st');
  assert.equal(u.searchParams.get('scope'), SCOPES.join(','));
});

test('authorizeUrl requires clientId', () => {
  assert.throws(() => authorizeUrl({ redirectUri: 'https://x/cb', state: 's' }), /clientId required/);
});

test('state is single-use and expires', () => {
  const s = newState();
  assert.equal(consumeState(s), true);
  assert.equal(consumeState(s), false); // already consumed
  const s2 = newState(1000);
  assert.equal(consumeState(s2, 1000 + 11 * 60 * 1000), false); // expired
});

test('exchangeCode normalizes the oauth.v2.access response', async () => {
  const fakeFetch = async () => ({
    json: async () => ({
      ok: true, access_token: 'xoxb-zzz', bot_user_id: 'UBOT',
      team: { id: 'T9', name: 'Acme' }, authed_user: { id: 'U5' },
    }),
  });
  const inst = await exchangeCode({ clientId: 'c', clientSecret: 's', code: 'x', redirectUri: 'r', fetchImpl: fakeFetch });
  assert.equal(inst.teamId, 'T9');
  assert.equal(inst.teamName, 'Acme');
  assert.equal(inst.botToken, 'xoxb-zzz');
  assert.equal(inst.botUserId, 'UBOT');
  assert.equal(inst.installedBy, 'U5');
  assert.ok(inst.installedAt);
});

test('exchangeCode throws on Slack error', async () => {
  const fakeFetch = async () => ({ json: async () => ({ ok: false, error: 'invalid_code' }) });
  await assert.rejects(
    () => exchangeCode({ clientId: 'c', clientSecret: 's', code: 'bad', redirectUri: 'r', fetchImpl: fakeFetch }),
    /invalid_code/,
  );
});
