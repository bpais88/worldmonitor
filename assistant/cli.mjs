// Local test harness for the agent — no Slack needed.
//   node assistant/cli.mjs "which ports are congested?"
//   node assistant/cli.mjs --allow-actions "save a congestion report"      (dry-run actions)
//   node assistant/cli.mjs --allow-actions --execute "save a report"        (perform actions)
// Env: RELAY_URL, RELAY_SHARED_SECRET, ANTHROPIC_API_KEY
import { runAgent } from './agent.mjs';
import { freightTools } from './tools/freight.mjs';
import { actionTools } from './tools/actions.mjs';
import { weatherTools } from './tools/weather.mjs';
import { watchTools } from './tools/watches.mjs';
import { DEFAULT_POLICY } from './guardrails.mjs';

const args = process.argv.slice(2);
const allowActions = args.includes('--allow-actions');
const execute = args.includes('--execute');
const question = args.filter((a) => !a.startsWith('--')).join(' ').trim();

if (!question) {
  console.error('usage: node assistant/cli.mjs [--allow-actions] [--execute] "your question"');
  process.exit(1);
}

const policy = { ...DEFAULT_POLICY, allowActions, execute };
const mode = !allowActions ? 'read-only' : execute ? 'EXECUTE actions' : 'dry-run actions';
console.error(`  [mode: ${mode}]`);

const { text, calls, audit } = await runAgent({
  userText: question,
  tools: [...freightTools, ...weatherTools, ...watchTools, ...actionTools],
  policy,
  onToolCall: (name, input, m) => console.error(`  · ${name}(${JSON.stringify(input || {})}) → ${m}`),
});

console.error(`  [tools used: ${calls.join(', ') || 'none'}]`);
if (audit.length) {
  console.error('  [action audit]');
  for (const a of audit) console.error(`    - ${a.tool}: ${a.mode}${a.reason ? ` (${a.reason})` : ''}`);
}
console.log('\n' + text + '\n');
