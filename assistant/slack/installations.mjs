// Multi-workspace installation + per-workspace config store, persisted via
// store.mjs (Upstash or in-memory fallback). This is what turns Marco from a
// single-tenant bot into a product customers can "Add to Slack": each workspace
// gets its own bot token (from the OAuth flow) and its own config (action users,
// watched ports/operators, onboarding state). Tokens are looked up per event by
// team_id, so one process serves every workspace.
import { kvGet, kvSet, kvDel, setAdd, setRem, setMembers } from '../store.mjs';

const INDEX = 'slack:teams';
const instKey = (teamId) => `slack:inst:${teamId}`;
const cfgKey = (teamId) => `slack:cfg:${teamId}`;

const DEFAULT_CONFIG = { ports: [], operators: [], actionUsers: [], onboarded: false };

/** Persist a workspace installation. inst: { teamId, teamName, botToken, botUserId, installedBy, installedAt }. */
export async function saveInstallation(inst) {
  if (!inst || !inst.teamId) throw new Error('saveInstallation: teamId required');
  await kvSet(instKey(inst.teamId), inst);
  await setAdd(INDEX, inst.teamId);
  return inst;
}

export async function getInstallation(teamId) {
  return teamId ? kvGet(instKey(teamId)) : null;
}

export async function listInstallations() {
  const ids = await setMembers(INDEX);
  const out = [];
  for (const id of ids) {
    const i = await kvGet(instKey(id));
    if (i) out.push(i);
    else await setRem(INDEX, id); // prune dangling index entries
  }
  return out;
}

export async function removeInstallation(teamId) {
  await kvDel(instKey(teamId));
  await kvDel(cfgKey(teamId));
  await setRem(INDEX, teamId);
}

/** Per-workspace config, always returns a full object (merged over defaults). */
export async function getConfig(teamId) {
  const c = (teamId && (await kvGet(cfgKey(teamId)))) || {};
  return { ...DEFAULT_CONFIG, ...c };
}

/** Shallow-merge a patch into a workspace's config and persist it. */
export async function setConfig(teamId, patch) {
  if (!teamId) throw new Error('setConfig: teamId required');
  const next = { ...(await getConfig(teamId)), ...patch };
  await kvSet(cfgKey(teamId), next);
  return next;
}

/** Add a Slack user id to a workspace's action allowlist (idempotent). */
export async function addActionUser(teamId, userId) {
  const cfg = await getConfig(teamId);
  if (userId && !cfg.actionUsers.includes(userId)) {
    return setConfig(teamId, { actionUsers: [...cfg.actionUsers, userId] });
  }
  return cfg;
}
