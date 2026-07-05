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
import { profileTools } from '../tools/profiles.mjs';
import { weatherTools } from '../tools/weather.mjs';
import { MARCO_PERSONA } from '../slack/onboarding.mjs';
import { DEFAULT_SYSTEM } from '../agent.mjs';

/** The read-only tool set exposed to voice — the exact same handlers Slack/Teams use. */
export const VOICE_TOOLS = [...freightTools, ...profileTools, ...weatherTools];
const TOOL_BY_NAME = new Map(VOICE_TOOLS.map((t) => [t.name, t]));

// Marco's voice identity — the channel persona (mirrors SLACK_SYSTEM / TEAMS_SYSTEM).
// ElevenLabs runs the LLM in Option A, so provision.mjs pushes this to the agent config —
// a SNAPSHOT: any change here (or to MARCO_PERSONA / the tool set) requires re-running
// provision.mjs, or the phone keeps the old brain (see the 2026-07-05 Italy-only incident).
// The persona is Slack-born ("lives in Slack") — swap that one phrase for the phone; the
// targeted replace falls through harmlessly if the persona wording ever changes (deferred:
// buildSystem(persona, addendum) to DRY all five channels).
const VOICE_PERSONA = MARCO_PERSONA.replace('who lives in Slack', 'answering the phone');
export const VOICE_SYSTEM =
  `${VOICE_PERSONA}\n\n${DEFAULT_SYSTEM}\n\n` +
  'You are on a VOICE CALL. Be concise and warm — the caller is listening, not reading. ' +
  'Short sentences. Say key numbers clearly and pause after them. If you lack data, say so ' +
  'plainly. You only answer freight/port/weather questions; you cannot take actions.';
export const VOICE_FIRST_MESSAGE =
  'Hi, this is Marco, your freight assistant. Which port or vessel can I help you with?';

// TTS seed — used ONLY when provision.mjs CREATES the agent. Ownership split (2026-07-05): the
// repo owns the BRAIN (prompt/first message/tools — provision overwrites, drift-check enforces);
// the ElevenLabs DASHBOARD owns the SOUND (voice, tts model, expressive mode, LLM) — provision
// never touches tts on updates, so UI tuning sticks.
export const VOICE_TTS = {
  voiceId: process.env.VOICE_ID || 'JBFqnCBsd6RMkjVDRZzb', // George — create-time default only
  modelId: process.env.VOICE_MODEL || 'eleven_turbo_v2',
};
// The live agent (created once by provision.mjs; stable across re-provisions).
export const VOICE_AGENT_ID = process.env.VOICE_AGENT_ID || 'agent_3401kwem9s5se1f888kfw6key927';

// The URL path each server tool is exposed at — single-sourced: emitted by the
// tool-config generator, parsed by the webhook, matched by the server mount.
const TOOLS_PREFIX = '/voice/tools/';

/** Constant-time secret comparison (pure, testable). */
export function secretMatches(provided, expected) {
  if (!expected || !provided) return false;
  const a = Buffer.from(String(provided));
  const b = Buffer.from(String(expected));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// The bearer secret ElevenLabs sends on each tool call — we set it on the tool via the
// API, so it's ours to rotate.
function providedSecret(headers) {
  const auth = headers['authorization'] || '';
  return auth.startsWith('Bearer ') ? auth.slice(7) : '';
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
  if (!u.pathname.startsWith(TOOLS_PREFIX)) return sendJson(res, 404, { error: 'not found' });
  const name = u.pathname.slice(TOOLS_PREFIX.length).replace(/\/+$/, '');
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

// ElevenLabs' request_body_schema rejects JSON-Schema keywords it doesn't model
// (`additionalProperties`, `$schema`), which Marco's tool schemas carry for strict
// Claude tool-use. Strip them recursively so the schema validates.
export function cleanSchema(s) {
  if (Array.isArray(s)) return s.map(cleanSchema);
  if (s && typeof s === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(s)) {
      if (k === 'additionalProperties' || k === '$schema') continue;
      out[k] = cleanSchema(v);
    }
    return out;
  }
  return s;
}

// Map one Marco tool → an ElevenLabs "server tool" config (verified against the live API).
export function toElevenLabsToolConfig(tool, baseUrl, secret) {
  const schema = tool.input_schema && tool.input_schema.properties
    ? tool.input_schema
    : { type: 'object', properties: {} };
  return {
    type: 'webhook',
    name: tool.name,
    description: tool.description,
    response_timeout_secs: 20,
    api_schema: {
      url: `${baseUrl.replace(/\/+$/, '')}${TOOLS_PREFIX}${tool.name}`,
      method: 'POST',
      request_headers: { Authorization: `Bearer ${secret}` },
      request_body_schema: cleanSchema(schema),
    },
  };
}
