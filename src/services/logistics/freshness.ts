// Turn the relay's freshness signals into a panel badge. Pure + tested: maps the
// feed meta (warming / stale / generatedAt) to a badge state the Panel understands
// plus a human detail string. Keeps the "is this data trustworthy right now?"
// decision in one place rather than scattered in the component.

import type { FeedMeta } from './providers/types';

export interface FreshnessBadge {
  /** Panel data-badge state: 'live' (green) or 'cached' (amber, not fully live). */
  state: 'live' | 'cached';
  /** Human suffix shown after the badge label, e.g. "as of 13:25:07 UTC". */
  detail: string;
}

/** "8s ago", "3m ago", "2h ago" from a seconds count. */
export function agoLabel(ageSec: number | undefined): string {
  if (!Number.isFinite(ageSec as number)) return 'just now';
  const s = Math.max(0, Math.round(ageSec as number));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

/** Amsterdam wall-clock "HH:MM CET/CEST" from epoch ms (Italy shares this zone). */
export function clockAmsterdam(epochMs: number): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Amsterdam',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZoneName: 'short',
  }).format(epochMs);
}

/**
 * Decide the freshness badge from feed meta. Time is shown in Amsterdam time.
 * - warming  → amber "warming up…" (count still filling after a relay restart)
 * - stale    → amber "stale · last update Xm ago" (ingest stalled)
 * - otherwise→ green "as of HH:MM CEST"
 */
export function describeFreshness(meta: FeedMeta | undefined): FreshnessBadge {
  if (!meta) return { state: 'live', detail: '' };
  if (meta.warming) return { state: 'cached', detail: 'warming up…' };
  if (meta.stale) return { state: 'cached', detail: `stale · last update ${agoLabel(meta.ageSec)}` };
  return { state: 'live', detail: meta.generatedAt ? `as of ${clockAmsterdam(meta.generatedAt)}` : '' };
}
