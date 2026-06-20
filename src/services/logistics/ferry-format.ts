// Shared presentation helpers for tracked ferries, so the table rows and the
// map popups render identical text. Pure + maplibre-free (unit-testable).

import type { TrackedFerry, FerryStatus } from './ferry-tracker';

export const FERRY_STATUS_LABEL: Record<FerryStatus, string> = {
  under_way: 'Under way',
  at_anchor: 'At anchor',
  in_port: 'In port',
};

/** Human ETA string, e.g. "44m", "~9h 6m" (inferred), "In port", "—". */
export function formatFerryEta(ferry: TrackedFerry): string {
  if (ferry.status === 'in_port') return 'In port';
  if (ferry.hoursRemaining === null) return '—';
  const totalMin = Math.round(ferry.hoursRemaining * 60);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  const eta = h > 0 ? `${h}h ${m}m` : `${m}m`;
  return ferry.etaSource === 'course_inference' ? `~${eta}` : eta;
}

/** Speed string, e.g. "18 kn" or "—". */
export function formatFerrySpeed(ferry: TrackedFerry): string {
  return typeof ferry.speedKnots === 'number' ? `${ferry.speedKnots.toFixed(0)} kn` : '—';
}
