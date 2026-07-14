// Scheduled ops self-report — the relay's daily health/gate summary, delivered to the owner.
//
// WHY THIS LIVES HERE: the same summary used to be produced by claude.ai scheduled routines that
// curl'd the relay's public /health from an Anthropic cloud sandbox. That sandbox's egress policy
// now 403s outbound CONNECTs to non-allowlisted hosts, so every run failed before reading anything.
// Marco already runs 24/7 on Railway, already reaches the relay (relayGet), and already delivers to
// Slack/Telegram (send) — so the check moved to where egress actually works. Read-only: it GETs the
// public /health and posts text. It touches no trips/portHistory write path.
//
// Env (all optional — with no OPS_REPORT_CHAT the ticker is inert, so deploying this changes nothing):
//   OPS_REPORT_CHAT      — delivery target: Telegram chat id, or Slack channel id.
//   OPS_REPORT_PLATFORM  — 'telegram' (default) | 'slack'. Both reuse the token the adapter already has.
//   OPS_REPORT_TEAM      — Slack only: workspace id, to resolve the install's bot token.
//   OPS_REPORT_HOUR_UTC  — daily send hour, UTC (default 6, matching the routine it replaces).
//   OPS_REPORT_TICK_MS   — how often the scheduler checks whether the send hour has passed (default 5 min).
import { relayGet } from './relay.mjs';
import { kvGet, kvSet } from './store.mjs';
import { getInstallation, legacyInstall, deliverFor } from './slack/installations.mjs';
import { send } from './send.mjs';

export const OPS_REPORT_CHAT = process.env.OPS_REPORT_CHAT || '';
const OPS_REPORT_PLATFORM = process.env.OPS_REPORT_PLATFORM || 'telegram';
const OPS_REPORT_TEAM = process.env.OPS_REPORT_TEAM || '';
const OPS_REPORT_HOUR_UTC = Number(process.env.OPS_REPORT_HOUR_UTC ?? 6);
export const OPS_REPORT_TICK_MS = Number(process.env.OPS_REPORT_TICK_MS) || 5 * 60_000;

// A report that missed its slot (Marco was down / redeploying at the send hour) still goes out when
// the process comes back — but only inside this window, so a restart at 23:00 doesn't fire the 06:00
// report six hours late into the owner's evening. Past the window the slot is skipped to tomorrow.
const CATCHUP_MS = 6 * 60 * 60_000;

const KEY_LAST_SENT = 'ops-report:lastSent';  // YYYY-MM-DD of the last delivered report (dedupes redeploys)
const KEY_CLEAN_SINCE = 'ops-report:cleanSince'; // YYYY-MM-DD the current degraded-free streak started

// Launch-gate definition (assistant/PHASE_C_SCOPE.md): trips.degraded must stay false for a CLEAN
// WEEK before vessel/port profiles can go paid. The pipeline went live 2026-07-02, so the earliest
// possible pass was 2026-07-09. A degraded reading restarts the clock from that day.
const TRIPS_LIVE_FROM = '2026-07-02';
const GATE_CLEAN_DAYS = 7;
// TRIP_MAX_OPEN_AGE_H (120h) * 60 in the relay — an open trip older than this means the abandon
// sweep is broken, and it is exactly what flips trips.degraded. Report the headroom before it does.
const TRIP_MAX_OPEN_AGE_MIN = 7200;
// Week-over-week corridor deltas need two clean weeks after the 2026-07-12 anchor-loss grace fix.
const WOW_VALID_FROM = '2026-07-26';

const dayKey = (now) => new Date(now).toISOString().slice(0, 10);
const daysBetween = (fromKey, toKey) =>
  Math.round((Date.parse(`${toKey}T00:00:00Z`) - Date.parse(`${fromKey}T00:00:00Z`)) / 86_400_000);
const pct = (n, d) => (d ? `${Math.round((n / d) * 100)}%` : '—');

/**
 * Has today's report come due and not yet been sent? Pure — `now` and the persisted `lastSent` day
 * are injected. Due = we're past the send hour, still inside the catch-up window, and the last
 * report we delivered was on an earlier day.
 */
export function isReportDue({ now, lastSent, hourUtc = OPS_REPORT_HOUR_UTC }) {
  const today = dayKey(now);
  if (lastSent === today) return false;
  const slot = Date.parse(`${today}T${String(hourUtc).padStart(2, '0')}:00:00Z`);
  return now >= slot && now - slot <= CATCHUP_MS;
}

/**
 * The clean-week clock. The routines were stateless and could only ever count days since the
 * pipeline went live; persisting the streak lets us honor the real gate rule — a degraded reading
 * RESETS the window to today. Returns the day the current clean streak started.
 */
export function nextCleanSince({ degraded, writeOk, today, cleanSince }) {
  if (degraded || writeOk === false) return today;      // gate reset — clock restarts today
  return cleanSince || TRIPS_LIVE_FROM;                 // first run: credit the streak from go-live
}

/**
 * Render the report the cloud routines used to produce, from a /health body. Pure (inject `now`), so
 * every verdict below is unit-tested against synthetic health payloads. Plain text, no markdown:
 * the Telegram connector sends without parse_mode, so asterisks would render literally.
 */
export function buildOpsReport({ health, now, cleanSince }) {
  const t = health?.trips || {};
  const ph = health?.portHistory || {};
  const bm = ph.baselineMaturity;
  const today = dayKey(now);
  const cleanDays = daysBetween(cleanSince || TRIPS_LIVE_FROM, today);
  const gateReset = !!t.degraded || t.lastTripWriteOk === false;
  const lines = [];

  // 1. Verdict first — the one line worth reading on a phone.
  if (gateReset) {
    lines.push('🚨 GATE RESET — trips pipeline degraded');
    lines.push(`The clean-week clock restarts today (${today}). degraded=${t.degraded} · lastTripWriteOk=${t.lastTripWriteOk}${t.lastTripError ? ` · ${t.lastTripError}` : ''}`);
  } else if (cleanDays >= GATE_CLEAN_DAYS) {
    lines.push(`✅ LAUNCH GATE SATISFIED — trips clean ${cleanDays}d (need ${GATE_CLEAN_DAYS})`);
    lines.push('Owner sign-off (PHASE_C_SCOPE.md, open decision #7) is the only step left before profiles go paid.');
  } else {
    lines.push(`⏳ Launch gate: day ${cleanDays} of ${GATE_CLEAN_DAYS} clean`);
  }

  // 2. The numbers behind the verdict.
  const closed = (t.tripsArrived || 0) + (t.tripsAbandoned || 0);
  lines.push('');
  lines.push(`Trips · opened ${t.tripsOpened} · arrived ${t.tripsArrived} · abandoned ${t.tripsAbandoned} (${pct(t.tripsArrived || 0, closed)} arrive) · resumed ${t.tripsResumed}`);
  lines.push(`  open ${t.openTripsTracked} (${t.openTripsInGrace} in grace, ${pct(t.openTripsInGrace || 0, t.openTripsTracked || 0)}) · oldest ${t.oldestOpenTripAgeMin}/${TRIP_MAX_OPEN_AGE_MIN} min · points ${t.tripPointRows} · dropped ${t.tripPointsDropped}`);

  // 3. Baseline maturity — the port-congestion forecast's runway (buckets are port×dow×hour, and a
  //    dow×hour recurs weekly, so ≥3 observed days per bucket takes ~3 weeks from 2026-07-02).
  if (!bm) {
    lines.push('Baselines · baselineMaturity missing from /health — relay predates the field (shipped 2026-07-05), not an error.');
  } else {
    let note = '';
    if (bm.trustedFrac > 0.5) note = ' — forecast backtest is becoming feasible';
    else if (bm.trusted > 0) note = ' — 🎉 first trusted buckets: live congestion labels are activating';
    else if (bm.maxDays >= bm.minDaysToTrust - 1) note = ' — trust is ~1 week out';
    else note = ' — still collecting';
    lines.push(`Baselines · ${bm.trusted}/${bm.buckets} trusted (${Math.round((bm.trustedFrac || 0) * 100)}%) · ${bm.portsWithTrusted}/${ph.zones} ports · maxDays ${bm.maxDays}/${bm.minDaysToTrust}${note}`);
  }
  lines.push(`PortHistory · degraded=${ph.degraded} · lastWriteOk=${ph.lastWriteOk} · snapshots ${ph.snapshotRows} · events ${ph.eventRows}`);

  // 4. Anomalies the routines were told to flag explicitly — silence here means "nothing odd".
  const anomalies = [];
  if (health?.status !== 'ok') anomalies.push(`relay status=${health?.status}`);
  if (health?.connected === false) anomalies.push('AIS upstream disconnected');
  if (t.lastTripError) anomalies.push(`lastTripError: ${t.lastTripError}`);
  if (t.tripPointsDropped > 0) anomalies.push(`tripPointsDropped=${t.tripPointsDropped} (should be 0)`);
  if (ph.lastError) anomalies.push(`portHistory.lastError: ${ph.lastError}`);
  if (ph.degraded) anomalies.push('portHistory degraded — durable store unavailable, running on fallback');
  // Not yet degraded, but the abandon sweep is running close to the 120h cap that would trip it.
  if (t.oldestOpenTripAgeMin != null && t.oldestOpenTripAgeMin > TRIP_MAX_OPEN_AGE_MIN * 0.95 && !t.degraded) {
    anomalies.push(`oldestOpenTripAgeMin ${t.oldestOpenTripAgeMin} is within 5% of the ${TRIP_MAX_OPEN_AGE_MIN} cap — the daily abandon sweep is close to the line`);
  }
  if (t.openTripsTracked && (t.openTripsInGrace || 0) / t.openTripsTracked > 0.4) {
    anomalies.push(`${pct(t.openTripsInGrace, t.openTripsTracked)} of open trips are in the anchor-loss grace window (>40% — grace may be too wide)`);
  }
  if (anomalies.length) {
    lines.push('');
    for (const a of anomalies) lines.push(`⚠️ ${a}`);
  }

  // 5. Sunday: the reminder half of the weekly routine. Pure text — it never needed egress, it was
  //    only stranded in the cloud sandbox alongside the health check.
  if (new Date(now).getUTCDay() === 0) {
    lines.push('');
    lines.push('— Sunday checklist —');
    lines.push('• Run `npm run report:corridor` locally (needs .env) — design-partner deliverable + retention heartbeat.');
    if (today >= WOW_VALID_FROM) lines.push('• Week-over-week deltas are now methodologically valid (two clean weeks post grace-fix) — add them to the report.');
    lines.push('• Data gates (need a local DB query): operator scorecards at ~100 eligible voyages/operator; per-vessel reliability at ≥20 eligible trips/vessel.');
  }

  return lines.join('\n');
}

/** The relay didn't answer. Loud by design: a relay that is DOWN is worse than one that is degraded. */
export function buildUnreachableReport({ error, attempts }) {
  return [
    '🚨 RELAY UNREACHABLE — health check failed',
    `${attempts} attempt(s), last error: ${error}`,
    'No gate verdict this run. Relay down is worse than degraded — check the Railway service.',
  ].join('\n');
}

/** Resolve the delivery target into an `install` record send() understands. Reuses the tokens the
 *  Telegram/Slack adapters already run on — this adds no new secret. */
async function resolveInstall() {
  if (OPS_REPORT_PLATFORM === 'telegram') {
    return { platform: 'telegram', deliver: { chatId: OPS_REPORT_CHAT } };
  }
  const install = (OPS_REPORT_TEAM ? await getInstallation(OPS_REPORT_TEAM) : null) || legacyInstall();
  return deliverFor(install) ? install : null;
}

/** GET the public /health, retrying once — a single blip shouldn't page the owner. */
async function fetchHealth() {
  try {
    return { health: await relayGet('/health'), attempts: 1 };
  } catch (first) {
    await new Promise((r) => setTimeout(r, 30_000));
    try {
      return { health: await relayGet('/health'), attempts: 2 };
    } catch (second) {
      return { error: second.message || String(second), attempts: 2 };
    }
  }
}

/**
 * One scheduler tick: if today's report is due, fetch health, render it, deliver it, and persist
 * both the sent-marker (so a redeploy can't double-send) and the clean-week streak. Never throws —
 * this is monitoring; a failure here must not take the host down with it.
 */
export async function tickOpsReport(now = Date.now()) {
  if (!OPS_REPORT_CHAT) return null; // not configured — feature inert
  try {
    const lastSent = await kvGet(KEY_LAST_SENT);
    if (!isReportDue({ now, lastSent })) return null;

    const { health, error, attempts } = await fetchHealth();
    let text;
    if (error) {
      text = buildUnreachableReport({ error, attempts });
    } else {
      const today = dayKey(now);
      const cleanSince = nextCleanSince({
        degraded: health?.trips?.degraded,
        writeOk: health?.trips?.lastTripWriteOk,
        today,
        cleanSince: await kvGet(KEY_CLEAN_SINCE),
      });
      await kvSet(KEY_CLEAN_SINCE, cleanSince);
      text = buildOpsReport({ health, now, cleanSince });
    }

    const install = await resolveInstall();
    if (!install) { console.warn('[ops-report] no delivery install resolved — report not sent'); return null; }
    await send(install, { channelId: OPS_REPORT_CHAT, text });
    await kvSet(KEY_LAST_SENT, dayKey(now));
    console.log(`[ops-report] delivered ${dayKey(now)} report to ${OPS_REPORT_PLATFORM}`);
    return text;
  } catch (e) {
    console.warn('[ops-report] tick error:', e.message);
    return null;
  }
}
