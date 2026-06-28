// Proactive watches: user-defined conditions the ticker evaluates against live
// data, alerting the channel only on a SUSTAINED state change. A raw state flip
// must persist for WATCH_DWELL_MS before it commits and alerts, so a signal that
// flaps near a threshold (e.g. port congestion hovering at the busy boundary)
// never spams. Persisted via store.mjs (Upstash or in-memory fallback). Pure-ish —
// evaluateWatches takes the already-fetched ports/vessels and an injectable `now`,
// so it's testable without network or wall-clock.
import { kvGet, kvSet, kvDel, setAdd, setRem, setMembers } from './store.mjs';

const INDEX = 'watches';
const key = (id) => `watch:${id}`;
let counter = 0;

// A state change must hold this long before it alerts (debounce). Env-tunable;
// default 30 min — comfortably longer than the ticker interval so brief flapping
// resolves back to the committed state before it ever matures into a notification.
export const WATCH_DWELL_MS = Number(process.env.WATCH_DWELL_MS) || 30 * 60_000;

export async function createWatch({ type, target, channel, thread, createdBy, team, condition = 'any', platform = 'slack', deliver }, now = Date.now()) {
  const id = `w_${now.toString(36)}_${(counter++).toString(36)}`;
  // `platform` + `deliver` let the ticker deliver an alert without a per-platform install
  // lookup: Slack resolves the workspace token by `team`; Teams has no per-tenant token, so
  // it carries its conversation reference (serviceUrl + accounts) here, captured at creation.
  const watch = { id, type, target, channel, thread, createdBy, team, condition, platform, deliver, lastState: null, pendingState: null, pendingSince: null, createdTs: now };
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

// Build the alert text for a confirmed transition prev -> state, honoring the
// watch's condition. Returns null when the transition isn't one this watch wants.
function transitionMessage(w, prev, state, p, v) {
  if (w.type === 'port_congestion') {
    if (!p) return null;
    const cond = w.condition || 'any'; // 'clears' | 'busy' | 'any'
    const becameBusy = state === 'busy' || state === 'congested';
    const becameClear = state === 'clear' && (prev === 'busy' || prev === 'congested');
    if (becameClear && (cond === 'clears' || cond === 'any')) {
      return `🟢 *${p.name}* has cleared (was ${prev}).`;
    }
    if (becameBusy && (cond === 'busy' || cond === 'any')) {
      return `🔴 *${p.name}* is now *${state}* — ${p.atPort} freight vessels at port, ${p.inbound} inbound.`;
    }
    return null;
  }
  if (w.type === 'vessel_delay') {
    if (v && state === 'delayed' && prev !== 'delayed') {
      const reasons = (v.delay.reasons || []).map((r) => r.summary).slice(0, 2).join('; ');
      return `🟠 *${v.name}* is now delayed${reasons ? ` — ${reasons}` : ''}.`;
    }
    return null;
  }
  return null;
}

/**
 * Evaluate all watches against fresh { ports, vessels } at time `now`. Returns
 * [{ watch, message }] for SUSTAINED transitions worth alerting, and persists
 * state. First evaluation just records a baseline (no alert). A raw state flip
 * starts a dwell clock (pendingState/pendingSince); only once the new state has
 * held continuously for WATCH_DWELL_MS does it commit and (maybe) alert. If the
 * signal reverts before then the candidate is discarded — so flapping is silent.
 */
export async function evaluateWatches({ ports = [], vessels = [] }, now = Date.now()) {
  const watches = await listWatches();
  const alerts = [];

  for (const w of watches) {
    // 1. Raw current state (plus the matched port/vessel, for the eventual message).
    let state, p = null, v = null;
    if (w.type === 'port_congestion') {
      p = matchPort(ports, w.target);
      state = p ? p.congestion : 'unknown';
    } else if (w.type === 'vessel_delay') {
      const q = String(w.target).toLowerCase();
      v = vessels.find((x) => (x.name || '').toLowerCase().includes(q));
      state = v && v.delay && (v.delay.slipping || v.delay.stalled) ? 'delayed' : 'ok';
    } else {
      continue;
    }

    // 2. Baseline: first reading just records, never alerts.
    if (w.lastState === null) {
      w.lastState = state; w.pendingState = null; w.pendingSince = null;
      await kvSet(key(w.id), w);
      continue;
    }

    // 3. Back at the committed state -> drop any maturing candidate, nothing to do.
    if (state === w.lastState) {
      if (w.pendingState != null) { w.pendingState = null; w.pendingSince = null; await kvSet(key(w.id), w); }
      continue;
    }

    // 4. A change. Debounce it: the new state must hold for WATCH_DWELL_MS.
    if (w.pendingState !== state) {
      w.pendingState = state; w.pendingSince = now; // new/changed candidate -> (re)start the clock
      await kvSet(key(w.id), w);
      continue;
    }
    if (now - (w.pendingSince ?? now) < WATCH_DWELL_MS) continue; // still maturing

    // 5. Confirmed: commit prev -> state and alert if this watch wants it.
    const prev = w.lastState;
    const message = transitionMessage(w, prev, state, p, v);
    w.lastState = state; w.pendingState = null; w.pendingSince = null;
    await kvSet(key(w.id), w);
    if (message) alerts.push({ watch: w, message });
  }
  return alerts;
}
