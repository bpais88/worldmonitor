import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  VOICE_TOOLS,
  secretMatches,
  parseToolInput,
  cleanSchema,
  toElevenLabsToolConfig,
  handleVoiceRequest,
} from './adapter.mjs';

// Minimal res stub capturing status + JSON body.
function mockRes() {
  return {
    statusCode: null,
    body: null,
    writeHead(status) { this.statusCode = status; return this; },
    end(payload) { this.body = payload ? JSON.parse(payload) : null; },
  };
}

test('VOICE_TOOLS is the read-only set (freight + weather, no actions/watches)', () => {
  const names = VOICE_TOOLS.map((t) => t.name);
  assert.ok(names.includes('get_port_congestion'));
  assert.ok(names.includes('get_marine_weather'));
  // Excluded: side-effecting actions + watches (no delivery target on a call).
  assert.ok(!names.includes('save_freight_report'));
  assert.ok(!names.includes('create_watch'));
});

test('secretMatches: constant-time compare, fails on empty/mismatch/length', () => {
  assert.equal(secretMatches('s3cret', 's3cret'), true);
  assert.equal(secretMatches('s3cret', 'nope'), false);
  assert.equal(secretMatches('', 's3cret'), false);
  assert.equal(secretMatches('s3cret', ''), false);
  assert.equal(secretMatches('s3cre', 's3cret'), false); // different length
});

test('parseToolInput: top-level params, `parameters` envelope, and bad JSON', () => {
  assert.deepEqual(parseToolInput('{"port":"rotterdam"}'), { port: 'rotterdam' });
  assert.deepEqual(parseToolInput('{"parameters":{"port":"genoa"}}'), { port: 'genoa' });
  assert.deepEqual(parseToolInput('not json'), {});
  assert.deepEqual(parseToolInput(''), {});
});

test('cleanSchema strips additionalProperties + $schema recursively', () => {
  const dirty = { type: 'object', $schema: 'x', additionalProperties: false, properties: { a: { type: 'object', additionalProperties: true } } };
  const c = cleanSchema(dirty);
  assert.equal('$schema' in c, false);
  assert.equal('additionalProperties' in c, false);
  assert.equal('additionalProperties' in c.properties.a, false);
  assert.equal(c.properties.a.type, 'object');
});

test('toElevenLabsToolConfig: webhook shape + strips ElevenLabs-forbidden schema keys', () => {
  const t = { name: 'get_port', description: 'd', input_schema: { type: 'object', properties: { port: { type: 'string' } }, additionalProperties: false } };
  const cfg = toElevenLabsToolConfig(t, 'https://relay.example.com/', 'SEKRET');
  assert.equal(cfg.type, 'webhook');
  assert.equal(cfg.name, 'get_port');
  assert.equal(cfg.api_schema.url, 'https://relay.example.com/voice/tools/get_port');
  assert.equal(cfg.api_schema.method, 'POST');
  assert.equal(cfg.api_schema.request_headers.Authorization, 'Bearer SEKRET');
  // ElevenLabs rejects additionalProperties — stripped; properties preserved.
  assert.equal('additionalProperties' in cfg.api_schema.request_body_schema, false);
  assert.deepEqual(cfg.api_schema.request_body_schema.properties, { port: { type: 'string' } });
});

test('handleVoiceRequest: 401 without the secret', async () => {
  process.env.VOICE_TOOL_SECRET = 'topsecret';
  const res = mockRes();
  await handleVoiceRequest({ headers: {} }, res, '{}', new URL('http://x/voice/tools/get_port_congestion'));
  assert.equal(res.statusCode, 401);
});

test('handleVoiceRequest: 404 for an unknown tool (past auth)', async () => {
  process.env.VOICE_TOOL_SECRET = 'topsecret';
  const res = mockRes();
  await handleVoiceRequest(
    { headers: { authorization: 'Bearer topsecret' } },
    res,
    '{}',
    new URL('http://x/voice/tools/does_not_exist'),
  );
  assert.equal(res.statusCode, 404);
  assert.match(res.body.error, /unknown tool/);
});
