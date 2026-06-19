import { Panel } from './Panel';
import { escapeHtml } from '@/utils/sanitize';
import {
  getTrackedItalianFerries,
  type TrackedFerry,
  type FerryStatus,
} from '@/services/logistics/ferry-tracker';

const REFRESH_INTERVAL_MS = 60_000;

const STATUS_LABEL: Record<FerryStatus, string> = {
  under_way: 'Under way',
  at_anchor: 'At anchor',
  in_port: 'In port',
};

const STATUS_CLASS: Record<FerryStatus, string> = {
  under_way: 'ferry-status-underway',
  at_anchor: 'ferry-status-anchor',
  in_port: 'ferry-status-port',
};

function formatEta(ferry: TrackedFerry): string {
  if (ferry.status === 'in_port') return 'In port';
  if (ferry.hoursRemaining === null) return '—';
  const totalMin = Math.round(ferry.hoursRemaining * 60);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  const eta = h > 0 ? `${h}h ${m}m` : `${m}m`;
  return ferry.etaSource === 'course_inference' ? `~${eta}` : eta;
}

/**
 * Live board of Italian island ferries derived from AIS. Self-contained: call
 * start() after mounting to begin polling. No app-wide data-loader wiring needed.
 */
export class ItalyFerryPanel extends Panel {
  private ferries: TrackedFerry[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    super({ id: 'italy-ferries', title: 'Italy Ferries', showCount: true });
  }

  public start(): void {
    void this.refresh();
    if (!this.timer) {
      this.timer = setInterval(() => void this.refresh(), REFRESH_INTERVAL_MS);
    }
  }

  public async refresh(): Promise<void> {
    try {
      const ferries = await getTrackedItalianFerries();
      this.ferries = ferries;
      this.setCount(ferries.length);
      this.setDataBadge('live', `${ferries.length} tracked`);
      this.render();
    } catch {
      this.setDataBadge('unavailable');
      if (this.ferries.length === 0) {
        this.showError('Ferry feed unavailable — is the AIS relay running?');
      }
    }
  }

  private render(): void {
    if (this.ferries.length === 0) {
      this.setContent('<div class="economic-empty">No Italian ferries currently in view.</div>');
      return;
    }

    // Group by destination island group (fallback bucket for unresolved).
    const groups = new Map<string, TrackedFerry[]>();
    for (const f of this.ferries) {
      const key = f.destinationGroup || (f.destinationName ? 'Other destinations' : 'Destination unknown');
      const bucket = groups.get(key) ?? [];
      bucket.push(f);
      groups.set(key, bucket);
    }

    const sections = [...groups.entries()].map(([group, ferries]) => {
      const rows = ferries.map((f) => {
        const operator = f.operatorName ? escapeHtml(f.operatorName) : '—';
        const dest = f.destinationName ? escapeHtml(f.destinationName) : 'unknown';
        const speed = typeof f.speedKnots === 'number' ? `${f.speedKnots.toFixed(0)} kn` : '—';
        return `<tr>
          <td class="ferry-name">${escapeHtml(f.name)}</td>
          <td class="ferry-operator">${operator}</td>
          <td><span class="ferry-status ${STATUS_CLASS[f.status]}">${STATUS_LABEL[f.status]}</span></td>
          <td class="ferry-dest">${dest}</td>
          <td class="ferry-speed">${speed}</td>
          <td class="ferry-eta">${escapeHtml(formatEta(f))}</td>
        </tr>`;
      }).join('');

      return `<div class="ferry-group">
        <div class="ferry-group-title">${escapeHtml(group)} <span class="ferry-group-count">${ferries.length}</span></div>
        <table class="ferry-table">
          <thead><tr>
            <th>Vessel</th><th>Operator</th><th>Status</th><th>Destination</th><th>Speed</th><th>ETA</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
    }).join('');

    this.setContent(`
      ${sections}
      <div class="economic-footer">
        <span class="economic-source">Source: AIS (aisstream.io) · ~ = inferred from course</span>
      </div>
    `);
  }

  public override destroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    super.destroy();
  }
}
