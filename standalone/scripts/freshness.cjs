'use strict';

// Data-freshness signals for the freight feed, derived from the relay's Marinesia
// poll state. Pure logic so the relay (and tests) can compute the same thing.
//
//   warming — the relay hasn't completed one full tile sweep since boot yet, so the
//             vessel set is still filling in (this is the "15 → 177" ramp). Callers
//             should show "warming up…" rather than a misleadingly low count.
//   stale   — the Marinesia poll has not succeeded recently (ingest stalled / outage),
//             so the data on hand is aging. Default threshold leaves margin for the
//             ~117s sweep + a 60s rate-limit backoff.

const DEFAULT_STALE_MS = 4 * 60 * 1000;

/**
 * @param {object} s
 * @param {number|null} s.lastPollAt  epoch ms of the last successful Marinesia poll (null = never)
 * @param {number} s.tilesSeen        DISTINCT tiles successfully polled since boot (not total polls —
 *                                    a duplicate success must not let a never-polled tile count as covered)
 * @param {number} s.tileCount        number of tiles in a full sweep
 * @param {number} [s.now]
 * @param {number} [s.staleMs]
 * @returns {{ warming: boolean, stale: boolean, ageSec: number|null }}
 */
function relayFreshness({ lastPollAt, tilesSeen, tileCount, now = Date.now(), staleMs = DEFAULT_STALE_MS }) {
  const warming = !(tilesSeen >= tileCount && tileCount > 0);
  const ageSec = Number.isFinite(lastPollAt) ? Math.max(0, Math.round((now - lastPollAt) / 1000)) : null;
  const stale = lastPollAt == null ? true : now - lastPollAt > staleMs;
  return { warming, stale, ageSec };
}

/**
 * Per-TILE freshness (P0.2 follow-up): has THIS tile been successfully polled recently? Shares
 * DEFAULT_STALE_MS with relayFreshness so the global and per-tile signals can never disagree on
 * what "recent" means (a ~117s sweep + a 60s rate-limit backoff both fit inside it).
 * @param {object} s
 * @param {number|null|undefined} s.lastOkAt  epoch ms of the tile's last successful poll
 * @param {number} [s.now]
 * @param {number} [s.staleMs]
 * @returns {boolean}
 */
function tileFreshness({ lastOkAt, now = Date.now(), staleMs = DEFAULT_STALE_MS }) {
  return Number.isFinite(lastOkAt) && now - lastOkAt <= staleMs;
}

module.exports = { relayFreshness, tileFreshness, DEFAULT_STALE_MS };
