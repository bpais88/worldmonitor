// ElevenLabs voice adapter — Marco's third channel (phone), reusing the SAME read
// tools as Slack + Teams. ElevenLabs runs the conversation (speech-to-text + LLM +
// text-to-speech + the phone number via Twilio). During a call its LLM invokes our
// "server tools" (webhooks): one URL per tool, the tool's parameters as the JSON body.
// We verify a shared secret, run the tool handler, and return the JSON result
// SYNCHRONOUSLY (ElevenLabs waits for the result to keep talking — unlike the Slack/
// Teams ack-then-process flow).
//
// Read-only by design: freight + weather queries only. No side-effecting action tools
// (there's no approval UI on a call) and no watches (a call has no persistent channel
// to deliver a proactive alert to — add SMS/linked-channel delivery before enabling).

import crypto from 'node:crypto';
import { freightTools } from '../tools/freight.mjs';
import { weatherTools } from '../tools/weather.mjs';

/** The read-only tool set exposed to voice — the exact same handlers Slack/Teams use. */
export const VOICE_TOOLS = [...freightTools, ...weatherTools];
const TOOL_BY_NAME = new Map(VOICE_TOOLS.map((t) => [t.name, t]));

/** Constant-time secret comparison (pure, testable). */
export function secretMatches(provided, expected) {
  if (!expected || !provided) return false;
  const a = Buffer.from(String(provided));
  const b = Buffer.from(String(expected));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// The secret ElevenLabs sends on each tool call — we set it on the tool via the API, so
// it's ours to rotate. Accept `Authorization: Bearer <secret>` or `X-Voice-Secret: <secret>`.
function providedSecret(headers) {
  const auth = headers['authorization'] || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  return bearer || headers['x-voice-secret'] || '';
}

function sendJson(res, status, obj) {
  const payload = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
}

/** Extract the tool params from the webhook body (defensive: top-level or a `parameters` envelope). */
export function parseToolInput(body) {
  if (!body) return {};
  let input;
  try { input = JSON.parse(body); } catch { return {}; }
  if (!input || typeof input !== 'object') return {};
  if (input.parameters && typeof input.parameters === 'object') return input.parameters;
  return input;
}

/**
 * ElevenLabs server-tool webhook. Path: /voice/tools/<tool_name>, body = the tool's
 * parameters (JSON). Verify the secret → run the read tool → return its JSON result.
 */
export async function handleVoiceRequest(req, res, body, u) {
  if (!secretMatches(providedSecret(req.headers), process.env.VOICE_TOOL_SECRET || '')) {
    return sendJson(res, 401, { error: 'unauthorized' });
  }
  const name = u.pathname.replace(/^\/voice\/tools\//, '').replace(/\/+$/, '');
  const tool = TOOL_BY_NAME.get(name);
  if (!tool) return sendJson(res, 404, { error: `unknown tool: ${name}` });

  const input = parseToolInput(body);
  // Voice is single-tenant + the read tools are stateless, so a fixed context suffices.
  const context = { platform: 'voice', channel: 'voice', user: 'caller', team: 'voice' };
  try {
    const result = await tool.handler(input, context);
    console.log(`[voice] ${name}(${Object.keys(input).join(',') || '—'}) ok`);
    return sendJson(res, 200, result ?? {});
  } catch (e) {
    console.error(`[voice] tool ${name} failed:`, e.message);
    // 200 + error field so the agent can tell the caller gracefully (a 5xx would break the turn).
    return sendJson(res, 200, { error: `tool ${name} failed: ${e.message}` });
  }
}

// ── Setup helpers (consumed by the ElevenLabs API provisioning script) ─────────────
// Map one Marco tool → an ElevenLabs "server tool" config. Field names follow the
// convai/tools API; finalized against the live API when the agent is provisioned.
export function toElevenLabsToolConfig(tool, baseUrl, secret) {
  return {
    type: 'webhook',
    name: tool.name,
    description: tool.description,
    response_timeout_secs: 20,
    api_schema: {
      url: `${baseUrl.replace(/\/+$/, '')}/voice/tools/${tool.name}`,
      method: 'POST',
      request_headers: { Authorization: `Bearer ${secret}` },
      request_body_schema:
        tool.input_schema && tool.input_schema.properties
          ? tool.input_schema
          : { type: 'object', properties: {} },
    },
  };
}

export function voiceToolConfigs(baseUrl, secret) {
  return VOICE_TOOLS.map((t) => toElevenLabsToolConfig(t, baseUrl, secret));
}
