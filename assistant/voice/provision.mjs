// One-command (re)provisioning of the "Marco — Freight Voice" ElevenLabs agent.
//
// Creates the read-only server tools (pointing at our /voice/tools/*), the agent
// (Marco persona + voice), and assigns the phone number for inbound. Idempotent by
// name: re-running reuses the existing tools/agent (updating the agent) instead of
// duplicating — so it's safe to run after a tool/persona change.
//
// Usage (secrets come from the env, never committed):
//   ELEVENLABS_API_KEY=sk_...  VOICE_TOOL_SECRET=...  PHONE_NUMBER_ID=phnum_... \
//   node assistant/voice/provision.mjs
//
// Optional env (defaults shown):
//   VOICE_BASE_URL  https://italy-freight-assistant-production.up.railway.app  (deployed assistant)
//   VOICE_ID        JBFqnCBsd6RMkjVDRZzb   (George — warm, professional)
//   VOICE_MODEL     eleven_turbo_v2        (English agents require turbo/flash v2)

import { VOICE_TOOLS, VOICE_SYSTEM, VOICE_FIRST_MESSAGE, VOICE_TTS, toElevenLabsToolConfig } from './adapter.mjs';

const API = 'https://api.elevenlabs.io';
// Idempotency key — renaming this orphans the existing agent (and its phone binding).
const AGENT_NAME = 'Marco — Freight Voice';

function reqEnv(name) {
  const v = process.env[name];
  if (!v) { console.error(`missing required env: ${name}`); process.exit(1); }
  return v;
}

const KEY = reqEnv('ELEVENLABS_API_KEY');
const SECRET = reqEnv('VOICE_TOOL_SECRET');
const BASE = process.env.VOICE_BASE_URL || 'https://italy-freight-assistant-production.up.railway.app';
const VOICE_ID = VOICE_TTS.voiceId; // single-sourced in adapter.mjs (drift-check verifies the same value)
const MODEL = VOICE_TTS.modelId;
const PHONE_ID = process.env.PHONE_NUMBER_ID || '';

function die(label, r) {
  console.error(`${label} FAILED (${r.status}):`, JSON.stringify(r.json).slice(0, 200));
  process.exit(1);
}

async function el(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'xi-api-key': KEY, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json };
}

async function main() {
  // 1. Tools — reuse existing by name, else create.
  const existing = await el('GET', '/v1/convai/tools');
  const idByName = new Map();
  for (const t of existing.json?.tools || []) idByName.set(t.tool_config?.name || t.name, t.id);

  const toolIds = [];
  for (const tool of VOICE_TOOLS) {
    let id = idByName.get(tool.name);
    if (id) {
      // UPDATE in place, don't just reuse: the ElevenLabs tool config is a SNAPSHOT of the tool's
      // description/schema at provisioning time. Reuse-without-update left the original 7 tools
      // describing "Italian" ports for days after #59 broadened everything to European — the same
      // frozen-copy failure mode as the agent prompt.
      const r = await el('PATCH', `/v1/convai/tools/${id}`, { tool_config: toElevenLabsToolConfig(tool, BASE, SECRET) });
      if (r.status !== 200) die(`tool ${tool.name} update`, r);
      console.log(`tool ${tool.name}: updated ${id}`);
    } else {
      const r = await el('POST', '/v1/convai/tools', { tool_config: toElevenLabsToolConfig(tool, BASE, SECRET) });
      id = r.json?.id;
      if (r.status !== 200 || !id) die(`tool ${tool.name}`, r);
      console.log(`tool ${tool.name}: created ${id}`);
    }
    toolIds.push(id);
  }

  // 2. Agent — update if it exists, else create.
  // OWNERSHIP SPLIT (2026-07-05): the REPO owns the brain (prompt, first message, tools) — updates
  // overwrite them, drift-check enforces them. The DASHBOARD owns the sound (voice_id, tts model,
  // expressive mode, LLM choice) — updates DON'T send tts, so UI tuning sticks. tts is only seeded
  // on first create. (Before this split, every provision reverted the owner's voice to George.)
  const brain = {
    agent: { first_message: VOICE_FIRST_MESSAGE, prompt: { prompt: VOICE_SYSTEM, tool_ids: toolIds } },
  };
  const agents = await el('GET', '/v1/convai/agents');
  let agentId = (agents.json?.agents || []).find((a) => a.name === AGENT_NAME)?.agent_id;
  if (agentId) {
    const u = await el('PATCH', `/v1/convai/agents/${agentId}`, { conversation_config: brain });
    if (u.status !== 200) die('agent update', u);
    console.log(`agent: updated ${agentId} (brain only — dashboard owns voice/tts)`);
  } else {
    const conversation_config = { ...brain, tts: { voice_id: VOICE_ID, model_id: MODEL } };
    const c = await el('POST', '/v1/convai/agents/create', { name: AGENT_NAME, conversation_config });
    agentId = c.json?.agent_id;
    if (!agentId) die('agent create', c);
    console.log(`agent: created ${agentId}`);
  }

  // 3. Assign the phone number (inbound).
  if (PHONE_ID) {
    const p = await el('PATCH', `/v1/convai/phone-numbers/${PHONE_ID}`, { agent_id: agentId });
    console.log(`phone ${PHONE_ID}: ${p.status === 200 ? 'assigned' : `FAILED (${p.status}) ${JSON.stringify(p.json).slice(0, 150)}`}`);
  } else {
    console.log('PHONE_NUMBER_ID not set — skipping number assignment.');
  }

  console.log(`\n✓ done. agent_id=${agentId}, ${toolIds.length} tools, voice=${VOICE_ID}.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
