import { Panel } from './Panel';
import { escapeHtml } from '@/utils/sanitize';
import { ItalyFerryMap } from './ItalyFerryMap';
import {
  getTrackedItalianFerries,
  type TrackedFerry,
  type FerryStatus,
} from '@/services/logistics/ferry-tracker';
import { FERRY_STATUS_LABEL, formatFerryEta, formatFerrySpeed } from '@/services/logistics/ferry-format';

const REFRESH_INTERVAL_MS = 60_000;

const STATUS_CLASS: Record<FerryStatus, string> = {
  under_way: 'ferry-status-underway',
  at_anchor: 'ferry-status-anchor',
  in_port: 'ferry-status-port',
};

/**
 * Live board of Italian island ferries derived from AIS. Self-contained: call
 * start() after mounting to begin polling. No app-wide data-loader wiring needed.
 */
export class ItalyFerryPanel extends Panel {
  private ferries: TrackedFerry[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private map: ItalyFerryMap | null = null;
  private mapMounted = false;
  private readonly ferryByMmsi = new Map<string, TrackedFerry>();

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
      this.setDataBadge('live');
      this.render();
    } catch {
      this.setDataBadge('unavailable');
      if (this.ferries.length === 0) {
        this.teardownMap();
        // Imperative (not setContent) so it never races the debounced content path.
        this.content.innerHTML = '<div class="error-message">Ferry feed unavailable — is the AIS relay running?</div>';
      }
    }
  }

  private render(): void {
    if (this.ferries.length === 0) {
      this.teardownMap();
      this.content.innerHTML = '<div class="economic-empty">No Italian ferries currently in view.</div>';
      return;
    }

    this.ensureScaffold();

    // Index by MMSI so a table-row click can focus the matching vessel on the map.
    this.ferryByMmsi.clear();
    for (const f of this.ferries) this.ferryByMmsi.set(f.mmsi, f);

    // Group by destination island group (fallback bucket for unresolved).
    const groups = new Map<string, TrackedFerry[]>();
    for (const f of this.ferries) {
      const key = f.destinationGroup || (f.destinationName ? 'Other destinations' : 'Destination unknown');
      const bucket = groups.get(key) ?? [];
      bucket.push(f);
      groups.set(key, bucket);
    }

    // One table with group header rows, so every column lines up across groups
    // (separate per-group tables sized their columns independently → misaligned).
    const body = [...groups.entries()].map(([group, ferries]) => {
      const groupRow = `<tr class="ferry-group-row"><td colspan="6">${escapeHtml(group)} <span class="ferry-group-count">${ferries.length}</span></td></tr>`;
      const rows = ferries.map((f) => {
        const operator = f.operatorName ? escapeHtml(f.operatorName) : '—';
        const destBadge = f.routeStatus === 'confirmed' ? ' <span class="ferry-route-ok" title="Scheduled route">✓</span>'
          : f.routeStatus === 'unknown' && f.destinationName ? ' <span class="ferry-route-warn" title="Off-schedule / unverified route">!</span>'
          : '';
        const dest = f.destinationName ? `${escapeHtml(f.destinationName)}${destBadge}` : 'unknown';
        return `<tr data-mmsi="${escapeHtml(f.mmsi)}" title="Show on map">
          <td class="ferry-name">${escapeHtml(f.name)}</td>
          <td class="ferry-operator">${operator}</td>
          <td><span class="ferry-status ${STATUS_CLASS[f.status]}">${FERRY_STATUS_LABEL[f.status]}</span></td>
          <td class="ferry-dest">${dest}</td>
          <td class="ferry-speed">${escapeHtml(formatFerrySpeed(f))}</td>
          <td class="ferry-eta">${escapeHtml(formatFerryEta(f))}</td>
        </tr>`;
      }).join('');
      return groupRow + rows;
    }).join('');

    const table = `<table class="ferry-table">
      <thead><tr>
        <th>Vessel</th><th>Operator</th><th>Status</th><th>Destination</th><th>Speed</th><th>ETA</th>
      </tr></thead>
      <tbody>${body}</tbody>
    </table>`;

    const board = this.content.querySelector('.ferry-board');
    if (board) board.innerHTML = table;
    this.map?.setFerries(this.ferries);
  }

  /**
   * Build the persistent map host + legend + table container once, synchronously
   * (bypassing the debounced setContent so the host exists immediately for the
   * MapLibre instance, which is then updated in place rather than re-created).
   */
  private ensureScaffold(): void {
    if (this.mapMounted) return;
    this.content.innerHTML = `
      <div class="ferry-map-host"></div>
      <div class="ferry-map-legend">
        <span><i style="background:#2fbf85"></i>Under way (arrow = heading)</span>
        <span><i style="background:#e0a032"></i>At anchor</span>
        <span><i style="background:#9aa0a6"></i>In port</span>
      </div>
      <div class="ferry-board"></div>
      <div class="economic-footer">
        <span class="economic-source">Source: AIS (aisstream.io) · ~ = inferred from course</span>
      </div>
    `;
    const host = this.content.querySelector<HTMLElement>('.ferry-map-host');
    if (host) this.map = new ItalyFerryMap(host);

    // Click a table row to fly to that vessel on the map (delegated, so it keeps
    // working as the board's innerHTML is replaced on each refresh).
    const board = this.content.querySelector<HTMLElement>('.ferry-board');
    board?.addEventListener('click', (e) => {
      const row = (e.target as HTMLElement).closest<HTMLElement>('tr[data-mmsi]');
      const mmsi = row?.dataset.mmsi;
      if (!mmsi) return;
      const ferry = this.ferryByMmsi.get(mmsi);
      if (ferry) this.map?.focusFerry(ferry);
    });

    this.mapMounted = true;
  }

  private teardownMap(): void {
    this.map?.destroy();
    this.map = null;
    this.mapMounted = false;
  }

  public override destroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.teardownMap();
    super.destroy();
  }
}
