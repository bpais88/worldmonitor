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

// Legacy single-workspace fallback: a deploy with no OAuth record for a team can
// still operate from an env bot token. legacyInstall() materializes that as the same
// neutral install shape the delivery layer (send.mjs) expects, so call sites never
// hand-build it. Returns null when no env token is set.
const ENV_BOT_TOKEN = process.env.SLACK_BOT_TOKEN || '';
const ENV_BOT_USER_ID = process.env.SLACK_BOT_USER_ID || '';
export const legacyInstall = () =>
  ENV_BOT_TOKEN ? { platform: 'slack', deliver: ENV_BOT_TOKEN, botUserId: ENV_BOT_USER_ID } : null;

// The delivery handle for an install: a Slack bot token, or (Teams, later) a
// conversation reference. The `?? botToken` branch is transitional back-compat for
// records persisted before the record was generalized; both writers now stamp
// `deliver`, so a re-saved record self-heals and this fallback can later be dropped.
export const deliverFor = (install) => install?.deliver ?? install?.botToken ?? null;

/** Persist a workspace installation. inst: { teamId, teamName, botToken, botUserId, installedBy, installedAt }. */
export async function saveInstallation(inst) {
  if (!inst || !inst.teamId) throw new Error('saveInstallation: teamId required');
  // Store in the platform-neutral shape (see send.mjs) so the delivery layer can
  // treat Slack and Teams uniformly. For Slack the delivery handle is the bot token.
  // Spread `inst` last so an already-stamped record keeps its own platform/deliver.
  const record = { platform: 'slack', deliver: inst.botToken, ...inst };
  await kvSet(instKey(inst.teamId), record);
  await setAdd(INDEX, inst.teamId);
  return record;
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
