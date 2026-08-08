// Per-user action permissions: map a Slack user id to a guardrail policy.
// Allowlisted users may EXECUTE actions; everyone else is read-only. This binds
// the guardrail (guardrails.mjs) to identity, so actions in a shared channel are
// only ever performed by trusted users. Pure — unit-tested without Slack.
import { DEFAULT_POLICY } from '../guardrails.mjs';

/** Parse a comma/space-separated list of Slack user ids into a Set. */
export function parseActionUsers(str) {
  return new Set(String(str || '').split(/[,\s]+/).map((s) => s.trim()).filter(Boolean));
}

/**
 * Policy for a given Slack user.
 * @param userId Slack user id (e.g. "U123ABC")
 * @param opts.actionUsers Set or string of user ids allowed to execute actions
 * @param opts.allowDryRunForAll if true, non-allowlisted users may dry-run (propose) actions
 */
export function policyForUser(userId, { actionUsers, allowDryRunForAll = false } = {}) {
  const allowed = actionUsers instanceof Set ? actionUsers : parseActionUsers(actionUsers);
  if (userId && allowed.has(userId)) {
    return { ...DEFAULT_POLICY, allowActions: true, execute: true };
  }
  // Non-privileged: read-only by default; optionally allowed to dry-run (no side effects).
  return { ...DEFAULT_POLICY, allowActions: allowDryRunForAll, execute: false };
}
