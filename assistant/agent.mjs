// Generic, tool-agnostic agent loop (the "brain"). Claude is given whatever tools
// are passed in, decides which to call, we run the handlers and feed results back,
// looping until it produces a final answer. Adding capabilities = passing more
// tools — this file never changes.
import Anthropic from '@anthropic-ai/sdk';
import { ANTHROPIC_API_KEY, ASSISTANT_MODEL } from './config.mjs';
import { evaluateToolCall, DEFAULT_POLICY } from './guardrails.mjs';

export const DEFAULT_SYSTEM =
  'You are Marco, a maritime logistics analyst for European commercial ports and ' +
  'freight vessels (cargo + RoPax ferries) — currently Italy, the UK, Spain, and the ' +
  'Netherlands. Answer using ONLY ' +
  'the provided tools and their returned data; if the data does not cover something, ' +
  'say so plainly rather than guessing. Be concise and concrete — cite vessel names, ' +
  'ports, and numbers. For a "report", lead with the headline signals (congested ' +
  'ports, delayed vessels + their causes).\n\n' +
  'The data is a LIVE AIS snapshot that shifts between readings (vessels are polled ' +
  'continuously). When you state counts or congestion, append "(as of HH:MM UTC)" ' +
  'using the current time given below. If the user questions consistency or says the ' +
  'numbers changed, explain plainly that the feed is live and moves between readings ' +
  '— that is expected, not an error or confusion on your part.\n\n' +
  'Some tools take ACTIONS (saving files, posting to Slack). If an action tool ' +
  'returns {blocked}, tell the user it needs actions enabled and DO NOT retry it. ' +
  'If it returns {dryRun}, tell the user exactly what you would do and that it was ' +
  'not performed. Never claim an action succeeded unless the tool result confirms it.';

const MAX_STEPS = 6;

// Reuse one client per API key (avoids re-constructing on every Slack message).
let _client = null;
let _clientKey = null;
function getClient(apiKey) {
  if (!_client || _clientKey !== apiKey) {
    _client = new Anthropic({ apiKey });
    _clientKey = apiKey;
  }
  return _client;
}

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
  policy = DEFAULT_POLICY,
  context = {},
  onToolCall,
} = {}) {
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');
  if (!Array.isArray(tools) || tools.length === 0) throw new Error('no tools provided');

  const client = getClient(apiKey);
  const toolDefs = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema }));
  const byName = new Map(tools.map((t) => [t.name, t]));
  const convo = [...history, { role: 'user', content: userText }];
  const calls = [];
  const audit = [];                 // every action tool call: {tool, input, mode, executed}
  const usage = { input: 0, output: 0 }; // accumulated token usage across steps
  const state = { actionsExecuted: 0 };
  // Give the model "now" so it can stamp live figures (the data shifts between polls).
  const sys = `${system}\n\nCurrent UTC time: ${new Date().toISOString().slice(0, 16).replace('T', ' ')}.`;

  for (let step = 0; step < MAX_STEPS; step++) {
    const resp = await client.messages.create({ model, max_tokens: 1024, system: sys, tools: toolDefs, messages: convo });
    if (resp.usage) { usage.input += resp.usage.input_tokens || 0; usage.output += resp.usage.output_tokens || 0; }
    convo.push({ role: 'assistant', content: resp.content });

    const toolUses = resp.content.filter((c) => c.type === 'tool_use');
    if (toolUses.length === 0) {
      const text = resp.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim();
      return { text, calls, audit, convo, usage };
    }

    const results = [];
    for (const tu of toolUses) {
      calls.push(tu.name);
      const tool = byName.get(tu.name);
      const input = tu.input || {};
      let out;

      if (!tool) {
        out = { error: `unknown tool ${tu.name}` };
      } else {
        const decision = evaluateToolCall(tool, policy, state);
        onToolCall?.(tu.name, input, decision.mode);
        if (decision.mode === 'execute') {
          try {
            out = await tool.handler(input, context); // uniform context; tools that don't need it ignore it
          } catch (e) {
            out = { error: e.message };
          }
          if (decision.kind === 'action') {
            state.actionsExecuted += 1;
            audit.push({ tool: tu.name, input, mode: 'executed' });
          }
        } else if (decision.mode === 'dryrun') {
          // Do NOT run the handler — describe the intended action so the model
          // tells the user what it would do.
          out = { dryRun: true, wouldCall: tu.name, withInput: input, note: decision.reason };
          audit.push({ tool: tu.name, input, mode: 'dryrun' });
        } else {
          out = { blocked: true, reason: decision.reason };
          audit.push({ tool: tu.name, input, mode: 'blocked', reason: decision.reason });
        }
      }
      results.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(out) });
    }
    convo.push({ role: 'user', content: results });
  }

  return { text: '(reached the tool-step limit without a final answer)', calls, audit, convo, usage };
}
