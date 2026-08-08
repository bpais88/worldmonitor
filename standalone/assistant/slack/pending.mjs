// Pending action store for the approval flow. When the agent proposes an action,
// we stash {tool, input, ...} here and post Approve/Reject buttons; the button's
// value carries the id. On approval we pop it and run the handler.
//
// Persisted via store.mjs (Upstash or in-memory fallback) with a TTL, so a proposal
// survives a redeploy and can be approved from any replica. Ids are random (not a
// process counter) so they don't collide across instances.
import crypto from 'node:crypto';
import { kvGet, kvSet, kvDel } from '../store.mjs';

const TTL_SEC = 30 * 60;
const key = (id) => `pending:${id}`;

export async function putPending(action) {
  const id = `act_${crypto.randomBytes(8).toString('hex')}`;
  await kvSet(key(id), action, TTL_SEC);
  return id;
}

/** Read without removing (button handler validates before executing). */
export async function peekPending(id) {
  return id ? kvGet(key(id)) : null;
}

/** Read and remove (call once an action is resolved). */
export async function takePending(id) {
  const v = await peekPending(id);
  if (v) await kvDel(key(id));
  return v;
}
