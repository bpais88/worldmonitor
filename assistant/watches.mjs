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
 * Cancel watches bound to a single Teams conversation — called when the bot is removed from
 * that chat/channel (the Teams analog of Slack's uninstall cleanup), so the ticker stops
 * evaluating + attempting alerts into a conversation it can no longer post to. Matches the
 * conversation exactly (1:1, where channel === conversationId) or by its channel root before
 * the `;messageid=` suffix (channel threads). Scoped to `team` (tenant). Returns the count.
 */
export async function cancelWatchesByConversation({ team, conversationId } = {}) {
  if (!conversationId) return 0;
  const ws = await listWatches({ team });
  let n = 0;
  for (const w of ws) {
    const ch = String(w.channel || '');
    if (ch === conversationId || ch.startsWith(`${conversationId};`)) { await cancelWatch(w.id, { team }); n++; }
  }
  return n;
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
 * Proactive DISRUPTION alerts (M4, spec assistant/DISRUPTION_SOURCES_SCOPE.md). Unlike the
 * transition watches above, a scheduled strike is a one-shot fact, not a flapping signal — so no
 * dwell; instead each watch remembers which event ids it already announced (notifiedEvents,
 * capped) and never repeats one. Owner decisions honored here:
 *   - port_congestion watches AUTO-INCLUDE their port's disruption alerts (watching a port means
 *     hearing about its strikes) + the dedicated 'port_disruption' type is disruptions-only.
 *   - pushes are OFFICIAL-CALENDAR ONLY (kind 'strike_scheduled', confidence ~0.9): news-matched
 *     reports stay pull-only via get_upcoming_disruptions — a hedged headline must never page you.
 * `fetchPortDisruptions(portId)` is injected (the host wires it to /ais/disruptions?port=, which
 * already applies the 7-day lookahead + area matching) so this stays testable without network.
 */
const NOTIFIED_CAP = 50;

export async function evaluateDisruptionWatches({ ports = [], fetchPortDisruptions }, now = Date.now()) {
  if (typeof fetchPortDisruptions !== 'function') return [];
  const watches = (await listWatches()).filter((w) => w.type === 'port_congestion' || w.type === 'port_disruption');
  if (!watches.length) return [];

  // One relay call per DISTINCT watched port, not per watch.
  const byPort = new Map(); // portId -> { port, watches: [] }
  for (const w of watches) {
    const p = matchPort(ports, w.target);
    if (!p) continue; // unknown target -> silent (the congestion path reports 'unknown' already)
    const e = byPort.get(p.portId) || { port: p, watches: [] };
    e.watches.push(w);
    byPort.set(p.portId, e);
  }

  const alerts = [];
  for (const [portId, { port, watches: ws }] of byPort) {
    let events = [];
    try { events = (await fetchPortDisruptions(portId)) || []; } catch { continue; } // best-effort per port
    const scheduled = events.filter((e) => e.kind === 'strike_scheduled' && e.id);
    if (!scheduled.length) continue;
    for (const w of ws) {
      const seen = new Set(w.notifiedEvents || []);
      let dirty = false;
      for (const e of scheduled) {
        if (seen.has(e.id)) continue;
        seen.add(e.id);
        dirty = true;
        const days = e.startsAt != null ? Math.ceil((e.startsAt - now) / 86_400_000) : null;
        const when = e.startsAt == null ? '' : days > 1 ? ` — starts ${new Date(e.startsAt).toISOString().slice(0, 10)} (in ${days} days)` : days === 1 ? ' — starts TOMORROW' : ' — in effect';
        alerts.push({ watch: w, message: `⚠️ *Scheduled strike affecting ${port.name}*${when}\n${e.summary}\n_Source: official strike registry · you're watching ${port.name} — say "stop watching ${port.name}" to mute._` });
      }
      if (dirty) {
        w.notifiedEvents = [...seen].slice(-NOTIFIED_CAP);
        await kvSet(key(w.id), w);
      }
    }
  }
  return alerts;
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
