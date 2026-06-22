// Pending action store for the approval flow. When the agent proposes an action,
// we stash {tool, input, ...} here and post Approve/Reject buttons; the button's
// value carries the id. On approval we pop it and run the handler. In-memory with
// a TTL so stale proposals can't be approved hours later.

const store = new Map(); // id -> { tool, input, requestedBy, channel, thread, ts }
const TTL_MS = 30 * 60 * 1000;
let counter = 0;

function gc(now) {
  for (const [k, v] of store) if (now - v.ts > TTL_MS) store.delete(k);
}

export function putPending(action, now = Date.now()) {
  gc(now);
  const id = `act_${now.toString(36)}_${(counter++).toString(36)}`;
  store.set(id, { ...action, ts: now });
  return id;
}

/** Read without removing (button handler validates before executing). */
export function peekPending(id, now = Date.now()) {
  const v = store.get(id);
  if (!v) return null;
  if (now - v.ts > TTL_MS) { store.delete(id); return null; }
  return v;
}

/** Read and remove (call once an action is resolved). */
export function takePending(id, now = Date.now()) {
  const v = peekPending(id, now);
  if (v) store.delete(id);
  return v;
}
