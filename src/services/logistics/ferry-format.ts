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

/** Size string from hull dimensions, e.g. "175 × 27 m", "175 m", or '' if unknown. */
export function formatFerrySize(ferry: TrackedFerry): string {
  const l = ferry.lengthMeters;
  const b = ferry.beamMeters;
  if (l && b) return `${Math.round(l)} × ${Math.round(b)} m`;
  if (l) return `${Math.round(l)} m`;
  return '';
}

/** Draught string, e.g. "6.4 m draught", or '' if unknown. */
export function formatFerryDraught(ferry: TrackedFerry): string {
  return ferry.draughtMeters ? `${ferry.draughtMeters.toFixed(1)} m draught` : '';
}

/** Delay label, e.g. "Delayed +25 min", "Stalled", or '' if on track. */
export function formatFerryDelay(ferry: TrackedFerry): string {
  const d = ferry.delay;
  if (!d) return '';
  if (d.stalled) return 'Stalled';
  if (d.slipping) {
    const g = typeof d.etaGrowthMin === 'number' && d.etaGrowthMin > 0 ? ` +${d.etaGrowthMin} min` : '';
    return `Delayed${g}`;
  }
  return '';
}

const REASON_ICON: Record<string, string> = { weather: '🌊', news: '📰', port: '⚓' };

/** The likely-cause line for a delay, e.g. "🌊 Rough conditions…", or '' if none. */
export function formatFerryWhy(ferry: TrackedFerry): string {
  const reasons = ferry.delay?.reasons;
  if (!reasons || reasons.length === 0) return '';
  const top = reasons[0];
  if (!top?.summary) return '';
  const icon = REASON_ICON[top.source] ?? '•';
  // Mark low-confidence (news) as tentative — never assert a false cause.
  const hedge = top.confidence < 0.6 ? 'Possibly: ' : '';
  return `${icon} ${hedge}${top.summary}`;
}
