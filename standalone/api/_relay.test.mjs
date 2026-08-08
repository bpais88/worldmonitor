import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRelayHandler } from './_relay.js';

// The edge proxies hold RELAY_SHARED_SECRET, so a fail-open key check here would turn them into an
// open, credentialed gateway to the relay. These pin the fail-CLOSED behaviour (security review).

const req = (url = 'https://app.test/api/ais-ports', init = {}) => new Request(url, init);

test('SECURITY: unset API_VALID_KEYS denies (503), it does not wave requests through', async () => {
  delete process.env.API_VALID_KEYS;
  process.env.RELAY_URL = 'https://relay.test';
  const handler = createRelayHandler({ relayPath: '/ais/ports', requireApiKey: true });
  const res = await handler(req());
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error, 'API_VALID_KEYS not configured');
});

test('SECURITY: a valid key passes, a wrong key and a prefix of a valid key are rejected', async () => {
  process.env.API_VALID_KEYS = 'alpha-key, beta-key';
  process.env.RELAY_URL = 'https://relay.test';
  const handler = createRelayHandler({ relayPath: '/ais/ports', requireApiKey: true });

  assert.equal((await handler(req('https://app.test/x', { headers: { 'x-api-key': 'nope' } }))).status, 401);
  assert.equal((await handler(req('https://app.test/x', { headers: { 'x-api-key': 'alpha' } }))).status, 401, 'prefix must not pass');
  assert.equal((await handler(req('https://app.test/x', { headers: {} }))).status, 401, 'absent key must not pass');

  // A valid key gets past auth and on to the upstream fetch (which fails here — no relay running).
  const ok = await handler(req('https://app.test/x', { headers: { 'x-api-key': 'beta-key' } }));
  assert.ok(ok.status === 502 || ok.status === 504, `expected an upstream error, got ${ok.status}`);
});

test('SECURITY: a key in the query string is NOT accepted (keeps secrets out of URLs)', async () => {
  process.env.API_VALID_KEYS = 'alpha-key';
  process.env.RELAY_URL = 'https://relay.test';
  const handler = createRelayHandler({ relayPath: '/ais/ports', requireApiKey: true });
  assert.equal((await handler(req('https://app.test/x?key=alpha-key'))).status, 401);
});

test('routes that do not require a key are unaffected by the config', async () => {
  delete process.env.API_VALID_KEYS;
  process.env.RELAY_URL = 'https://relay.test';
  const handler = createRelayHandler({ relayPath: '/ais/ports' });
  const res = await handler(req());
  assert.ok(res.status !== 503, 'no requireApiKey -> no key gate');
});

test('OPTIONS preflight short-circuits before any auth check', async () => {
  delete process.env.API_VALID_KEYS;
  const handler = createRelayHandler({ relayPath: '/ais/ports', requireApiKey: true });
  const res = await handler(req('https://app.test/x', { method: 'OPTIONS' }));
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
});
