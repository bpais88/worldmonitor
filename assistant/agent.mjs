// Generic, tool-agnostic agent loop (the "brain"). Claude is given whatever tools
// are passed in, decides which to call, we run the handlers and feed results back,
// looping until it produces a final answer. Adding capabilities = passing more
// tools — this file never changes.
import Anthropic from '@anthropic-ai/sdk';
import { ANTHROPIC_API_KEY, ASSISTANT_MODEL } from './config.mjs';

export const DEFAULT_SYSTEM =
  'You are the Italy Freight assistant — a maritime logistics analyst for Italian ' +
  'commercial ports and freight vessels (cargo + RoPax ferries). Answer using ONLY ' +
  'the provided tools and their returned data; if the data does not cover something, ' +
  'say so plainly rather than guessing. Be concise and concrete — cite vessel names, ' +
  'ports, and numbers. For a "report", lead with the headline signals (congested ' +
  'ports, delayed vessels + their causes). The data is live AIS.';

const MAX_STEPS = 6;

/**
 * Run one agent turn. `tools` is an array of { name, description, input_schema,
 * handler(input)->any }. `history` is prior Anthropic messages (for threads).
 * Returns { text, calls, convo } where convo can seed the next turn.
 */
export async function runAgent({
  userText,
  history = [],
  tools,
  system = DEFAULT_SYSTEM,
  apiKey = ANTHROPIC_API_KEY,
  model = ASSISTANT_MODEL,
  onToolCall,
} = {}) {
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');
  if (!Array.isArray(tools) || tools.length === 0) throw new Error('no tools provided');

  const client = new Anthropic({ apiKey });
  const toolDefs = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema }));
  const byName = new Map(tools.map((t) => [t.name, t]));
  const convo = [...history, { role: 'user', content: userText }];
  const calls = [];

  for (let step = 0; step < MAX_STEPS; step++) {
    const resp = await client.messages.create({ model, max_tokens: 1024, system, tools: toolDefs, messages: convo });
    convo.push({ role: 'assistant', content: resp.content });

    const toolUses = resp.content.filter((c) => c.type === 'tool_use');
    if (toolUses.length === 0) {
      const text = resp.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim();
      return { text, calls, convo };
    }

    const results = [];
    for (const tu of toolUses) {
      calls.push(tu.name);
      onToolCall?.(tu.name, tu.input);
      const tool = byName.get(tu.name);
      let out;
      try {
        out = tool ? await tool.handler(tu.input || {}) : { error: `unknown tool ${tu.name}` };
      } catch (e) {
        out = { error: e.message };
      }
      results.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(out) });
    }
    convo.push({ role: 'user', content: results });
  }

  return { text: '(reached the tool-step limit without a final answer)', calls, convo };
}
