// Deterministic grounding guard (runs in CI). Every channel runs the SAME brain — agent.mjs +
// MARCO_PERSONA + DEFAULT_SYSTEM over the freight+weather tools — so guarding the brain here guards
// Slack, Teams, Voice, WhatsApp, and Telegram at once. This catches the STRUCTURAL ways Marco could
// stop grounding: the "use only the tools" instruction being softened away, a tool losing its
// handler/description, or the routing hints that tell the model WHEN to call a tool disappearing.
// It does NOT test the model's live behaviour — that's the paid, nightly behavioural eval
// (eval/tool-grounding.mjs).
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { DEFAULT_SYSTEM } from './agent.mjs';
import { freightTools } from './tools/freight.mjs';
import { weatherTools } from './tools/weather.mjs';

// The read-only tool floor every channel exposes (Slack/Teams add action+watch tools on top).
const READ_TOOLS = [...freightTools, ...weatherTools];
const EXPECTED = [
  'get_port_congestion', 'get_port', 'find_freight_vessels', 'get_vessel',
  'get_delayed_vessels', 'get_voyage_stats', 'get_marine_weather',
];

test('the shared system prompt keeps the tool-grounding instruction', () => {
  // Softening these is the class of bug behind the "Rotterdam" miss — Marco starts answering from
  // the model's memory instead of live data. Keep them load-bearing.
  assert.match(DEFAULT_SYSTEM, /ONLY the provided tools/i);
  assert.match(DEFAULT_SYSTEM, /rather than guessing/i);
});

test('the expected read tools are all wired and well-formed', () => {
  const byName = new Map(READ_TOOLS.map((t) => [t.name, t]));
  for (const name of EXPECTED) {
    const t = byName.get(name);
    assert.ok(t, `expected tool "${name}" is present`);
    assert.equal(typeof t.handler, 'function', `${name} has a handler`);
    assert.equal(typeof t.input_schema, 'object', `${name} has an input_schema`);
    assert.ok((t.description || '').length > 40, `${name} has a substantive description`);
  }
});

test('freight tools carry when-to-use routing hints', () => {
  // The "Use for ..." trigger phrases tell the model WHEN to call each tool; strip them and routing
  // degrades (it stops calling the right tool for a question). Guard them.
  for (const t of freightTools) {
    assert.match(t.description, /Use for/i, `${t.name} should include "Use for" routing hints`);
  }
});
