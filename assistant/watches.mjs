// Proactive watches: user-defined conditions the ticker evaluates against live
// data, alerting the channel only on a STATE CHANGE (so no repeat spam). Persisted
// via store.mjs (Upstash or in-memory fallback). Pure-ish — evaluateWatches takes
// the already-fetched ports/vessels so it's testable without network.
import { kvGet, kvSet, kvDel, setAdd, setRem, setMembers } from './store.mjs';

const INDEX = 'watches';
const key = (id) => `watch:${id}`;
let counter = 0;

export async function createWatch({ type, target, channel, thread, createdBy, team, condition = 'any' }, now = Date.now()) {
  const id = `w_${now.toString(36)}_${(counter++).toString(36)}`;
  const watch = { id, type, target, channel, thread, createdBy, team, condition, lastState: null, createdTs: now };
  await kvSet(key(id), watch);
  await setAdd(INDEX, id);
  return watch;
}

// Pass { team } to get only that workspace's watches (tenant isolation). No filter
// (the ticker) returns every watch across workspaces, which it needs to evaluate.
export async function listWatches({ team } = {}) {
  const ids = await setMembers(INDEX);
  const out = [];
  for (const id of ids) {
    const w = await kvGet(key(id));
    if (!w) { await setRem(INDEX, id); continue; } // prune dangling index entries
    if (team && w.team !== team) continue;
    out.push(w);
  }
  return out;
}

// Cancel one watch by id. Pass { team } to refuse cancelling another workspace's
// watch (tenant guard); omit it for trusted internal callers. Returns true if removed.
export async function cancelWatch(id, { team } = {}) {
  const w = await kvGet(key(id));
  if (!w) return false;
  if (team && w.team !== team) return false;
  await kvDel(key(id));
  await setRem(INDEX, id);
  return true;
}

/**
 * Cancel watches by human target name (port/vessel), scoped to a team. Mirrors the
 * lenient matching used when creating a watch, so "stop watching Porto Marghera"
 * resolves the same way "alert me when Porto Marghera clears" did. Optional `type`
 * narrows to port_congestion / vessel_delay. Returns the cancelled watches so the
 * caller can confirm exactly what it stopped.
 */
export async function cancelWatchesByTarget({ team, target, type } = {}) {
  const q = String(target || '').toLowerCase().trim();
  if (!q) return [];
  const ws = await listWatches({ team });
  const matched = ws.filter((w) => {
    if (type && w.type !== type) return false;
    const t = String(w.target).toLowerCase();
    return t === q || t.includes(q) || q.includes(t);
  });
  for (const w of matched) await cancelWatch(w.id, { team });
  return matched;
}

/**
 * Cancel every watch belonging to a workspace — called on uninstall so we honor the
 * privacy policy's "watches removed when you uninstall Marco". Returns the count removed.
 */
export async function cancelWatchesForTeam(team) {
  if (!team) return 0;
  const ws = await listWatches();
  let n = 0;
  for (const w of ws) {
    if (w.team === team) { await cancelWatch(w.id); n++; }
  }
  return n;
}

const matchPort = (ports, target) => {
  const q = String(target).toLowerCase();
  return ports.find((p) => p.name.toLowerCase() === q || String(p.portId).toLowerCase() === q || p.name.toLowerCase().includes(q));
};

/**
 * Evaluate all watches against fresh { ports, vessels }. Returns
 * [{ watch, message }] for transitions worth alerting, and persists new states.
 * First evaluation just records a baseline (no alert), so existing conditions
 * don't fire on startup.
 */
export async function evaluateWatches({ ports = [], vessels = [] }) {
  const watches = await listWatches();
  const alerts = [];

  for (const w of watches) {
    let state;
    let message = null;

    if (w.type === 'port_congestion') {
      const p = matchPort(ports, w.target);
      state = p ? p.congestion : 'unknown';
      if (p && w.lastState !== null && state !== w.lastState) {
        const cond = w.condition || 'any'; // 'clears' | 'busy' | 'any'
        const becameBusy = state === 'busy' || state === 'congested';
        const becameClear = state === 'clear' && (w.lastState === 'busy' || w.lastState === 'congested');
        if (becameClear && (cond === 'clears' || cond === 'any')) {
          message = `🟢 *${p.name}* has cleared (was ${w.lastState}).`;
        } else if (becameBusy && (cond === 'busy' || cond === 'any')) {
          message = `🔴 *${p.name}* is now *${state}* — ${p.atPort} freight vessels at port, ${p.inbound} inbound.`;
        }
      }
    } else if (w.type === 'vessel_delay') {
      const q = String(w.target).toLowerCase();
      const v = vessels.find((x) => (x.name || '').toLowerCase().includes(q));
      const delayed = !!(v && v.delay && (v.delay.slipping || v.delay.stalled));
      state = delayed ? 'delayed' : 'ok';
      if (v && delayed && w.lastState !== null && w.lastState !== 'delayed') {
        const reasons = (v.delay.reasons || []).map((r) => r.summary).slice(0, 2).join('; ');
        message = `🟠 *${v.name}* is now delayed${reasons ? ` — ${reasons}` : ''}.`;
      }
    } else {
      continue;
    }

    if (state !== w.lastState) {
      w.lastState = state;
      await kvSet(key(w.id), w);
    }
    if (message) alerts.push({ watch: w, message });
  }
  return alerts;
}
