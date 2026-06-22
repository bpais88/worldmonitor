// Guardrails for action tools. Read tools always run; action tools (mutating or
// outward-facing) are gated by a policy with conservative defaults. Pure logic so
// it unit-tests without the agent or network.
//
// Escalation:
//   default            -> actions BLOCKED (read-only; agent must ask to enable)
//   allowActions       -> actions DRY-RUN (handler not called; intent only)
//   allowActions+execute -> actions EXECUTE (capped by maxActions, audited)

export const DEFAULT_POLICY = {
  allowActions: false,   // master switch for kind:'action' tools
  execute: false,        // when false, actions are dry-run (no side effects)
  allowedTools: null,    // null = all action tools allowed; or a Set of names
  maxActions: 5,         // cap on executed actions per run
};

export function toolKind(tool) {
  return tool && tool.kind === 'action' ? 'action' : 'read';
}

/**
 * Decide how a single tool call should be handled.
 * @returns {{mode:'execute'|'dryrun'|'blocked', kind:'read'|'action', reason?:string}}
 */
export function evaluateToolCall(tool, policy = DEFAULT_POLICY, state = {}) {
  const kind = toolKind(tool);
  if (kind === 'read') return { mode: 'execute', kind };

  if (!policy.allowActions) {
    return { mode: 'blocked', kind, reason: 'actions are disabled (read-only mode) — ask the user to enable actions' };
  }
  if (policy.allowedTools && !policy.allowedTools.has(tool.name)) {
    return { mode: 'blocked', kind, reason: `"${tool.name}" is not in the allowed-actions list` };
  }
  if (!policy.execute) {
    return { mode: 'dryrun', kind, reason: 'dry-run: action described but not executed' };
  }
  if ((state.actionsExecuted || 0) >= policy.maxActions) {
    return { mode: 'blocked', kind, reason: `action limit reached (${policy.maxActions} per run)` };
  }
  return { mode: 'execute', kind };
}
