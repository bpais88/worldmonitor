// Behavioural eval: does Marco actually CALL the right tool for a data question, instead of
// answering from the model's memory? Runs the real shared brain (runAgent + MARCO_PERSONA +
// DEFAULT_SYSTEM) over representative questions with STUB tool handlers — real names, descriptions,
// and schemas (what drives routing), but canned returns — so we test the model's tool CHOICE in
// isolation, with no relay/network dependency. Only needs ANTHROPIC_API_KEY.
//
// NOT a per-PR gate: it's paid and mildly non-deterministic. It runs nightly
// (.github/workflows/assistant-eval.yml) so a regression that makes Marco stop grounding surfaces
// within a day. Run locally with: npm run eval:assistant
import { runAgent, DEFAULT_SYSTEM } from '../agent.mjs';
import { freightTools } from '../tools/freight.mjs';
import { profileTools } from '../tools/profiles.mjs';
import { weatherTools } from '../tools/weather.mjs';
import { MARCO_PERSONA } from '../slack/onboarding.mjs';

if (!process.env.ANTHROPIC_API_KEY) {
  console.log('⚠️  ANTHROPIC_API_KEY not set — skipping behavioural eval (add it as a repo secret for the nightly).');
  process.exit(0);
}

// Real descriptions/schemas (these drive routing), stub handlers (canned) — isolates tool CHOICE
// from whether the relay is up.
const STUB_TOOLS = [...freightTools, ...profileTools, ...weatherTools].map((t) => ({
  ...t,
  handler: async () => ({ stub: true, note: 'eval stub — the tool was correctly called' }),
}));
const SYSTEM = `${MARCO_PERSONA}\n\n${DEFAULT_SYSTEM}`;

// Each case: a data question and the tool(s) that could legitimately answer it.
const CASES = [
  // get_port_profile is a legitimate answer for live port questions too (it serves live congestion).
  { q: 'Is Rotterdam busy?', expect: ['get_port', 'get_port_congestion', 'get_port_profile'] },
  { q: 'Which ports are congested right now?', expect: ['get_port_congestion'] },
  { q: 'Where is the MOBY FANTASY?', expect: ['get_vessel', 'find_freight_vessels'] },
  { q: 'What freight is delayed today and why?', expect: ['get_delayed_vessels'] },
  { q: 'How many trips did you track this week?', expect: ['get_voyage_stats'] },
  { q: 'What is happening at the port of Genoa?', expect: ['get_port', 'get_port_congestion', 'get_port_profile'] },
  { q: "What's the marine weather near Livorno?", expect: ['get_marine_weather'] },
  // Phase C profile tools (PR-5): historical/track-record questions must route to the profile
  // tools, not the live-state ones (and never the model's memory).
  { q: 'Look up trip 4821 for me.', expect: ['get_trip'] },
  { q: 'How reliable is the vessel with MMSI 563279500 — how many trips has it made and is it usually on time?', expect: ['get_vessel_profile'] },
  { q: "What's Rotterdam's track record — median dwell time and which operators call there?", expect: ['get_port_profile'] },
];

let failures = 0;
for (const c of CASES) {
  try {
    const { calls } = await runAgent({ userText: c.q, tools: STUB_TOOLS, system: SYSTEM });
    const hit = calls.some((name) => c.expect.includes(name));
    console.log(`${hit ? '✅' : '❌'} "${c.q}"  → called: [${calls.join(', ') || 'none'}]  (expected one of: ${c.expect.join(', ')})`);
    if (!hit) failures++;
  } catch (e) {
    console.log(`❌ "${c.q}"  → ERROR: ${e.message}`);
    failures++;
  }
}

console.log(`\n${CASES.length - failures}/${CASES.length} grounded.` +
  (failures ? ` ${failures} MISSED — Marco answered from memory instead of calling a tool.` : ' Every question triggered the right tool.'));
process.exit(failures ? 1 : 0);
