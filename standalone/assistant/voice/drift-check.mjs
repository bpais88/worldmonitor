// Voice-channel DRIFT CHECK — is the live ElevenLabs agent what the repo says it should be?
//
// The phone is an Option A snapshot: provision.mjs pushes prompt/tools/voice INTO ElevenLabs, and
// dashboard edits are silently overwritten by the next provision (and vice versa: repo changes do
// nothing until provisioned). This script is the tripwire for BOTH failure modes:
//   - repo changed, provision not re-run  → live agent is stale (the 2026-07-05 "Italy-only" bug)
//   - dashboard edited by hand            → will be clobbered by the next provision (lost work)
// Either way the fix is the same: make the change in the REPO, then re-run provision.mjs.
//
// Runs nightly in CI (.github/workflows/voice-drift.yml, needs the ELEVENLABS_API_KEY secret) and
// locally via `npm run drift:voice`. Exits 0 in sync, 1 on drift, 0 with a skip note if no key.

import { VOICE_TOOLS, VOICE_SYSTEM, VOICE_FIRST_MESSAGE, VOICE_AGENT_ID } from './adapter.mjs';

const KEY = process.env.ELEVENLABS_API_KEY;
if (!KEY) {
  console.log('⚠️  ELEVENLABS_API_KEY not set — skipping voice drift check (add it as a repo secret for the nightly).');
  process.exit(0);
}

const API = 'https://api.elevenlabs.io';
async function el(path) {
  const res = await fetch(`${API}${path}`, { headers: { 'xi-api-key': KEY } });
  const json = await res.json().catch(() => ({}));
  if (res.status !== 200) { console.error(`❌ GET ${path} → ${res.status} ${JSON.stringify(json).slice(0, 200)}`); process.exit(1); }
  return json;
}

const agent = await el(`/v1/convai/agents/${VOICE_AGENT_ID}`);
const cfg = agent.conversation_config || {};
const prompt = cfg.agent?.prompt || {};
const drifts = [];
const ok = (label) => console.log(`✅ ${label}`);
const bad = (label, detail) => { console.log(`❌ ${label}${detail ? ` — ${detail}` : ''}`); drifts.push(label); };

// 1. System prompt — exact match against the repo's VOICE_SYSTEM.
if ((prompt.prompt || '') === VOICE_SYSTEM) ok('system prompt matches VOICE_SYSTEM');
else {
  const live = prompt.prompt || '';
  let i = 0;
  while (i < live.length && i < VOICE_SYSTEM.length && live[i] === VOICE_SYSTEM[i]) i++;
  bad('system prompt DIFFERS', `first divergence at char ${i}: live "…${live.slice(Math.max(0, i - 20), i + 40)}…"`);
}

// 2. First message.
if ((cfg.agent?.first_message || '') === VOICE_FIRST_MESSAGE) ok('first message matches');
else bad('first message DIFFERS', `live: "${(cfg.agent?.first_message || '').slice(0, 80)}"`);

// 3. TTS voice/model/LLM are DASHBOARD-owned (ownership split) — report, never flag.
console.log(`ℹ️  sound (dashboard-owned): voice=${cfg.tts?.voice_id} model=${cfg.tts?.model_id} llm=${prompt.llm || 'default'}`);

// 4. Tool set — names attached to the agent vs VOICE_TOOLS, and each live description vs the repo's.
const toolIds = prompt.tool_ids || [];
const all = await el('/v1/convai/tools');
const byId = new Map((all.tools || []).map((t) => [t.id, t.tool_config || {}]));
const liveNames = new Set(toolIds.map((id) => byId.get(id)?.name).filter(Boolean));
const wantNames = new Set(VOICE_TOOLS.map((t) => t.name));
const missing = [...wantNames].filter((n) => !liveNames.has(n));
const extra = [...liveNames].filter((n) => !wantNames.has(n));
if (!missing.length && !extra.length) ok(`tool set matches (${wantNames.size} tools)`);
else bad('tool set DIFFERS', `missing: [${missing.join(', ')}] extra: [${extra.join(', ')}]`);
for (const tool of VOICE_TOOLS) {
  const liveCfg = [...byId.values()].find((c) => c.name === tool.name);
  if (!liveCfg) continue; // already reported as missing
  // Compare a prefix — ElevenLabs may normalize whitespace/length on very long descriptions.
  const a = String(liveCfg.description || '').slice(0, 180);
  const b = String(tool.description || '').slice(0, 180);
  if (a === b) ok(`tool ${tool.name} description current`);
  else bad(`tool ${tool.name} description STALE`, 'live config predates the repo wording — re-run provision.mjs');
}

if (drifts.length) {
  console.log(`\n🚨 ${drifts.length} drift(s). The repo is the source of truth: make the change in`);
  console.log('   assistant/voice/ (persona/tools/VOICE_TTS) and re-run provision.mjs. Dashboard-only');
  console.log('   edits WILL be overwritten by the next provision — port them into the repo instead.');
  process.exit(1);
}
console.log('\n✓ Voice channel in sync with the repo.');
