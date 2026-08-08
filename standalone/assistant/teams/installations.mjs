// Teams install / conversation-reference store, persisted via store.mjs (Upstash or the
// in-memory fallback). Unlike Slack — where each workspace has its own bot token from
// OAuth — Teams has NO per-tenant token. The unit we persist is a CONVERSATION REFERENCE
// captured on first contact (the conversationUpdate activity): serviceUrl + the bot/user
// channel accounts. That reference is what lets Marco (a) greet on install and (b) push
// proactive watch alerts later — resume the reference and send() to it with no inbound
// message to reply to. Keyed by the opaque conversationId (unique per 1:1 / channel /
// groupChat). Self-prunes dangling index entries on read, like slack/installations.mjs.
import { kvGet, kvSet, kvDel, setAdd, setRem, setMembers } from '../store.mjs';

const INDEX = 'teams:convs';
const key = (conversationId) => `teams:inst:${conversationId}`;

/**
 * Upsert the conversation reference for a Teams conversation, preserving the `onboarded`
 * flag across updates. ref: { conversationId, tenantId, conversationType, deliver } — where
 * `deliver` is the opaque send.mjs handle (built by normalize.toTeamsDeliver; serviceUrl is
 * refreshed each time since it's regional and can change). Returns the stored record.
 */
export async function recordTeamsConversation(ref) {
  if (!ref || !ref.conversationId) throw new Error('recordTeamsConversation: conversationId required');
  const existing = (await getTeamsInstall(ref.conversationId)) || {};
  const record = {
    platform: 'teams',
    onboarded: false,
    ...existing, // keep an already-set onboarded flag (and any future fields)
    conversationId: ref.conversationId,
    tenantId: ref.tenantId || existing.tenantId || '',
    conversationType: ref.conversationType || existing.conversationType || 'personal',
    deliver: ref.deliver ?? existing.deliver,
  };
  await kvSet(key(ref.conversationId), record);
  if (!existing.conversationId) await setAdd(INDEX, ref.conversationId); // index on first contact only
  return record;
}

export async function getTeamsInstall(conversationId) {
  return conversationId ? kvGet(key(conversationId)) : null;
}

export async function listTeamsInstalls() {
  const ids = await setMembers(INDEX);
  const out = [];
  for (const id of ids) {
    const rec = await kvGet(key(id));
    if (rec) out.push(rec);
    else await setRem(INDEX, id); // prune dangling index entries (self-heal on read)
  }
  return out;
}

export async function removeTeamsInstall(conversationId) {
  await kvDel(key(conversationId));
  await setRem(INDEX, conversationId);
}

/**
 * Mark a conversation greeted so the welcome fires exactly once (idempotent onboarding).
 * Takes the already-loaded record (the caller has it in hand from recordTeamsConversation),
 * so this is a single write with no redundant re-read.
 */
export async function markTeamsOnboarded(record) {
  if (!record?.conversationId) return null;
  const next = { ...record, onboarded: true };
  await kvSet(key(record.conversationId), next);
  return next;
}
