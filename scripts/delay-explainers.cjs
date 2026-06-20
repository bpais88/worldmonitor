'use strict';

// Pluggable "why is this ferry delayed?" explainer registry.
//
// Each explainer is { id, explain(context) -> Promise<Reason[]> }, where
//   context = { mmsi, lat, lon, destPortId, destName, operatorName, etaGrowthMin, stalled }
//   Reason  = { source, kind, summary, confidence, url?, detail? }
//
// The "why" is open-ended — new sources (port congestion, mechanical advisories,
// traffic, customs, ...) are added by registering another explainer here. The
// pure ranking/dedupe logic lives in aggregateReasons() and is unit-tested; each
// explainer keeps its data-fetch glue thin and its interpretation pure.

/** Merge + rank candidate reasons (highest confidence first), deduped by kind+source. */
function aggregateReasons(reasons) {
  // Rank first so that, when deduping by source+kind, the higher-confidence
  // duplicate is the one kept.
  const ranked = reasons
    .filter((r) => r && r.summary)
    .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
  const seen = new Set();
  const out = [];
  for (const r of ranked) {
    const key = `${r.source}:${r.kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

/**
 * Run every enabled explainer for a flagged crossing and return ranked reasons.
 * Explainers run concurrently; one failing never blocks the others.
 */
async function runExplainers(explainers, context) {
  const settled = await Promise.allSettled(
    explainers.map((e) => Promise.resolve().then(() => e.explain(context))),
  );
  const reasons = [];
  for (const s of settled) {
    if (s.status === 'fulfilled' && Array.isArray(s.value)) reasons.push(...s.value);
  }
  return aggregateReasons(reasons);
}

module.exports = { aggregateReasons, runExplainers };
