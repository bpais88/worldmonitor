'use strict';

// PORT CONTEXT (M2, spec assistant/DISRUPTION_SOURCES_SCOPE.md) — the "why is this port busy?"
// layer. Pure reason-builders live here (unit-tested); the relay owns the fetch/cache loop and
// feeds them news matches, meteoalarm matches, live weather, and the port's own baseline bucket.
// Every reason is hedged by construction: {source, kind, summary, confidence} — the agent prompt
// instructs "possibly related", never asserted, and consumers show confidence-appropriate wording.

const { aggregateReasons } = require('./delay-explainers.cjs');

// Container cranes typically suspend operations around 20–25 m/s (~40–50 kn) gusts; terminals
// slow before they stop. Sustained wind is a weaker proxy when the gust reading is missing.
const CRANE_SLOW_GUST_KN = 40;
const CRANE_STOP_GUST_KN = 50;
const CRANE_SLOW_WIND_KN = 35;

/** Wind → likely cargo-operations impact. Pure; null when winds are unremarkable. */
function craneWindReason({ windKts, windGustKts } = {}) {
  const gust = Number.isFinite(windGustKts) ? windGustKts : null;
  const wind = Number.isFinite(windKts) ? windKts : null;
  if (gust != null && gust >= CRANE_STOP_GUST_KN) {
    return {
      source: 'weather-ops', kind: 'crane_wind',
      summary: `Gusts ~${Math.round(gust)} kn — above typical crane-stop limits; cargo operations likely suspended`,
      confidence: 0.75,
    };
  }
  if (gust != null && gust >= CRANE_SLOW_GUST_KN) {
    return {
      source: 'weather-ops', kind: 'crane_wind',
      summary: `Gusts ~${Math.round(gust)} kn — near crane operating limits; cargo handling likely slowed`,
      confidence: 0.6,
    };
  }
  if (gust == null && wind != null && wind >= CRANE_SLOW_WIND_KN) {
    return {
      source: 'weather-ops', kind: 'crane_wind',
      summary: `Sustained wind ~${Math.round(wind)} kn — cargo handling may be slowed`,
      confidence: 0.5,
    };
  }
  return null;
}

/**
 * The port's OWN data as context: current berth count vs its baseline for this local dow×hour.
 * Only speaks when the baseline bucket is trusted (days ≥ minDays) AND the port is above its p90 —
 * "busy but normal for a Tuesday morning" is not a disruption. Pure; null otherwise.
 */
function baselineAnomalyReason({ atBerth, bucket, minDays = 3 } = {}) {
  if (!Number.isFinite(atBerth) || !bucket) return null;
  const { p75, p90, days } = bucket;
  if (!Number.isFinite(days) || days < minDays || !Number.isFinite(p90)) return null;
  if (atBerth <= p90) return null;
  const p75Note = Number.isFinite(p75) ? ` (p75 ${Math.round(p75)})` : '';
  return {
    source: 'baseline', kind: 'above_normal',
    summary: `${Math.round(atBerth)} vessels at berth vs a typical p90 of ${Math.round(p90)}${p75Note} for this local hour — well above this port's own normal`,
    confidence: 0.7,
  };
}

/** Merge candidate reasons (nulls welcome) → ranked, deduped, capped. Pure. */
function assemblePortContext(candidates, cap = 4) {
  return aggregateReasons((candidates || []).filter(Boolean)).slice(0, cap);
}

module.exports = { craneWindReason, baselineAnomalyReason, assemblePortContext, CRANE_SLOW_GUST_KN, CRANE_STOP_GUST_KN };
