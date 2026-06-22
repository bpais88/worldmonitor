// Proactive watches: user-defined conditions the ticker evaluates against live
// data, alerting the channel only on a STATE CHANGE (so no repeat spam). Persisted
// via store.mjs (Upstash or in-memory fallback). Pure-ish — evaluateWatches takes
// the already-fetched ports/vessels so it's testable without network.
import { kvGet, kvSet, kvDel, setAdd, setRem, setMembers } from './store.mjs';

const INDEX = 'watches';
const key = (id) => `watch:${id}`;
let counter = 0;

export async function createWatch({ type, target, channel, thread, createdBy }, now = Date.now()) {
  const id = `w_${now.toString(36)}_${(counter++).toString(36)}`;
  const watch = { id, type, target, channel, thread, createdBy, lastState: null, createdTs: now };
  await kvSet(key(id), watch);
  await setAdd(INDEX, id);
  return watch;
}

export async function listWatches() {
  const ids = await setMembers(INDEX);
  const out = [];
  for (const id of ids) {
    const w = await kvGet(key(id));
    if (w) out.push(w);
    else await setRem(INDEX, id); // prune dangling index entries
  }
  return out;
}

export async function cancelWatch(id) {
  const existed = !!(await kvGet(key(id)));
  await kvDel(key(id));
  await setRem(INDEX, id);
  return existed;
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
        if (state === 'busy' || state === 'congested') {
          message = `🔴 *${p.name}* is now *${state}* — ${p.atPort} freight vessels at port, ${p.inbound} inbound.`;
        } else if (state === 'clear' && (w.lastState === 'busy' || w.lastState === 'congested')) {
          message = `🟢 *${p.name}* has cleared (was ${w.lastState}).`;
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
