// Local test harness for the agent — no Slack needed.
//   RELAY_URL=... RELAY_SHARED_SECRET=... ANTHROPIC_API_KEY=... \
//     node assistant/cli.mjs "which ports are congested?"
import { runAgent } from './agent.mjs';
import { freightTools } from './tools/freight.mjs';

const question = process.argv.slice(2).join(' ').trim();
if (!question) {
  console.error('usage: node assistant/cli.mjs "your question"');
  process.exit(1);
}

const { text, calls } = await runAgent({
  userText: question,
  tools: freightTools,
  onToolCall: (name, input) => console.error(`  · ${name}(${JSON.stringify(input || {})})`),
});

console.error(`  [tools used: ${calls.join(', ') || 'none'}]`);
console.log('\n' + text + '\n');
