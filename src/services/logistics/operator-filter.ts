// Operator attribution for the freight board's chip row.
//
// Split out of FreightPanel so the one invariant that matters here is testable without a DOM: the
// number a chip DISPLAYS and the number of rows selecting that chip SHOWS are produced by the same
// predicate. When those drifted apart, a chip read "64" and then listed a different count, and the
// board silently misreported its own coverage.

import type { TrackedFerry } from './ferry-tracker';

/**
 * Sentinel operator filter for "vessels we could not attribute to any operator".
 *
 * Carried in a chip's `data-op` attribute, so it must be a non-empty string that no real
 * operatorId can collide with — real ids come from the AIS operator registry and are plain
 * slugs, never bracketed.
 */
export const UNATTRIBUTED = '[none]';

/** Can this vessel be attributed to a named operator? The single source of truth. */
export function hasOperator(f: TrackedFerry): boolean {
  return Boolean(f.operatorId && f.operatorName);
}

export interface OperatorTally {
  /** Operators present in this set, sorted by display name. */
  operators: { id: string; name: string; count: number }[];
  /** Vessels resolving to some named operator — the real denominator for a chip's count. */
  attributed: number;
  /** Vessels broadcasting no operator we can resolve. */
  unattributed: number;
  /** Every vessel tracked in the region, attributed or not. */
  total: number;
}

/** Tally the operators present in a region's vessels, in one pass. */
export function tallyOperators(regional: TrackedFerry[]): OperatorTally {
  const byId = new Map<string, string>();
  const counts = new Map<string, number>();
  let attributed = 0;
  for (const f of regional) {
    if (!hasOperator(f)) continue;
    const id = f.operatorId as string;
    byId.set(id, f.operatorName as string);
    counts.set(id, (counts.get(id) ?? 0) + 1);
    attributed += 1;
  }
  const operators = [...byId.entries()]
    .map(([id, name]) => ({ id, name, count: counts.get(id) ?? 0 }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { operators, attributed, unattributed: regional.length - attributed, total: regional.length };
}

/**
 * Does this vessel pass the given operator chip?
 *
 * `null` = the "All" chip. Must stay the exact complement of the tally above: a vessel counted
 * under operator X passes filter X, and every vessel NOT counted under any operator passes
 * UNATTRIBUTED.
 */
export function matchesOperatorFilter(f: TrackedFerry, filter: string | null): boolean {
  if (!filter) return true;
  if (filter === UNATTRIBUTED) return !hasOperator(f);
  return hasOperator(f) && f.operatorId === filter;
}
