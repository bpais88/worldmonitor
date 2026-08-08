import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { evaluateToolCall, toolKind, DEFAULT_POLICY } from './guardrails.mjs';

const readTool = { name: 'get_ports' };                // no kind -> read
const actionTool = { name: 'save_report', kind: 'action' };

test('read tools always execute, regardless of policy', () => {
  assert.equal(evaluateToolCall(readTool, DEFAULT_POLICY).mode, 'execute');
  assert.equal(toolKind(readTool), 'read');
});

test('action tools are blocked by default (read-only)', () => {
  const d = evaluateToolCall(actionTool, DEFAULT_POLICY);
  assert.equal(d.mode, 'blocked');
  assert.match(d.reason, /disabled|read-only/);
});

test('allowActions without execute -> dry-run', () => {
  const d = evaluateToolCall(actionTool, { ...DEFAULT_POLICY, allowActions: true });
  assert.equal(d.mode, 'dryrun');
});

test('allowActions + execute -> execute', () => {
  const d = evaluateToolCall(actionTool, { ...DEFAULT_POLICY, allowActions: true, execute: true }, { actionsExecuted: 0 });
  assert.equal(d.mode, 'execute');
});

test('allowlist blocks tools not on it', () => {
  const policy = { ...DEFAULT_POLICY, allowActions: true, execute: true, allowedTools: new Set(['other']) };
  assert.equal(evaluateToolCall(actionTool, policy).mode, 'blocked');
  const ok = { ...policy, allowedTools: new Set(['save_report']) };
  assert.equal(evaluateToolCall(actionTool, ok, { actionsExecuted: 0 }).mode, 'execute');
});

test('maxActions caps executed actions', () => {
  const policy = { ...DEFAULT_POLICY, allowActions: true, execute: true, maxActions: 2 };
  assert.equal(evaluateToolCall(actionTool, policy, { actionsExecuted: 1 }).mode, 'execute');
  assert.equal(evaluateToolCall(actionTool, policy, { actionsExecuted: 2 }).mode, 'blocked');
});
