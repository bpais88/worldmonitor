'use strict';

// Method B: ETA-drift detection from a per-vessel time series of ETA snapshots.
//
// Pure logic, no I/O — the relay feeds it snapshots and persists the buffers
// (Upstash); this module decides whether a crossing's predicted arrival is
// *slipping* (running late vs how it looked minutes ago) or *stalled* (stopped
// mid-crossing). Storage-agnostic so it unit-tests without a relay or Redis.
//
// "Late" needs a baseline. With no published timetable we use the vessel's own
// recent trend as the baseline: if the predicted arrival keeps moving later
// while it's still heading to the same port, the crossing is slipping. (A
// learned per-route "normal duration" baseline can layer on top later.)

// A snapshot is: { ts, etaTs, destPortId, speed }
//   ts        — observation time (epoch ms)
//   etaTs      — predicted arrival time (epoch ms), or null if not under way
//   destPortId — resolved destination port id (or '' if unknown)
//   speed      — speed over ground (knots)

const DEFAULTS = {
  maxSnapshots: 120,        // ring-buffer cap per vessel (~2h at 60s polls)
  minSamples: 3,            // need at least this many in-window to judge
  minWindowMs: 10 * 60_000, // span the window must cover before we trust drift
  slipThresholdMin: 10,     // predicted arrival moved >this many min later = slipping
  staleSnapshotMs: 6 * 3_600_000, // drop snapshots older than this
  stalledKnots: 0.5,        // at/below this = not moving
  wasMovingKnots: 3,        // a recent sample above this = it had been under way
};

/** Append a snapshot to a vessel's buffer, trimming stale + over-cap entries. Pure. */
function recordSnapshot(buffer, snapshot, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const out = Array.isArray(buffer) ? buffer.slice() : [];
  out.push(snapshot);
  // Drop stale relative to the newest snapshot's ts.
  const newest = snapshot.ts;
  let trimmed = out.filter((s) => newest - s.ts <= o.staleSnapshotMs);
  // Cap length (keep most recent).
  if (trimmed.length > o.maxSnapshots) trimmed = trimmed.slice(trimmed.length - o.maxSnapshots);
  return trimmed;
}

/**
 * Decide whether the latest crossing is slipping/stalled.
 * Returns null when there isn't enough signal to judge (so callers can omit a
 * delay field rather than asserting "on time" prematurely).
 */
function detectDrift(buffer, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  if (!Array.isArray(buffer) || buffer.length === 0) return null;

  const latest = buffer[buffer.length - 1];
  // Only consider the current leg: contiguous tail with the same destination.
  // A destination change starts a fresh crossing, so older snapshots don't apply.
  const leg = [];
  for (let i = buffer.length - 1; i >= 0; i--) {
    if (buffer[i].destPortId !== latest.destPortId) break;
    leg.push(buffer[i]);
  }
  leg.reverse();

  // Stalled: currently not moving, but was under way within this leg, and we
  // have a real destination (so it's mid-crossing, not just sitting in port).
  const stalled =
    latest.destPortId !== '' &&
    (latest.speed ?? 0) <= o.stalledKnots &&
    leg.some((s) => (s.speed ?? 0) >= o.wasMovingKnots);

  // Slip: predicted arrival moved later across the window. Needs ETA on both ends.
  const withEta = leg.filter((s) => Number.isFinite(s.etaTs));
  let slipping = false;
  let etaGrowthMin = 0;
  let windowMin = 0;
  let samples = withEta.length;

  if (withEta.length >= o.minSamples) {
    const first = withEta[0];
    const last = withEta[withEta.length - 1];
    windowMin = Math.round((last.ts - first.ts) / 60_000);
    if (last.ts - first.ts >= o.minWindowMs) {
      etaGrowthMin = Math.round((last.etaTs - first.etaTs) / 60_000);
      slipping = etaGrowthMin >= o.slipThresholdMin;
    }
  }

  if (!slipping && !stalled) {
    // Not enough evidence of a problem — but report the trend if we measured it.
    if (samples >= o.minSamples && windowMin > 0) {
      return { slipping: false, stalled: false, etaGrowthMin, windowMin, samples };
    }
    return null;
  }
  return { slipping, stalled, etaGrowthMin, windowMin, samples };
}

module.exports = { recordSnapshot, detectDrift, DEFAULTS };
