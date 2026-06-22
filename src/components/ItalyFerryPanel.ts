import { Panel } from './Panel';
import { escapeHtml } from '@/utils/sanitize';
import { ItalyFerryMap } from './ItalyFerryMap';
import {
  getTrackedItalianFerries,
  type TrackedFerry,
  type FerryStatus,
} from '@/services/logistics/ferry-tracker';
import { FERRY_STATUS_LABEL, formatFerryEta, formatFerrySpeed, formatFerryDelay } from '@/services/logistics/ferry-format';
import { getPortStatus, type PortStatus } from '@/services/logistics/port-status';

const REFRESH_INTERVAL_MS = 60_000;

type BoardMode = 'vessels' | 'ports';

const STATUS_CLASS: Record<FerryStatus, string> = {
  under_way: 'ferry-status-underway',
  at_anchor: 'ferry-status-anchor',
  in_port: 'ferry-status-port',
};

const CONGESTION_LABEL: Record<PortStatus['congestion'], string> = {
  clear: 'Clear', busy: 'Busy', congested: 'Congested',
};

/**
 * Live board of Italian freight vessels derived from AIS, with a Vessels/Ports
 * toggle. Self-contained: call start() after mounting to begin polling.
 */
export class ItalyFerryPanel extends Panel {
  private ferries: TrackedFerry[] = [];
  private ports: PortStatus[] = [];
  private mode: BoardMode = 'vessels';
  private timer: ReturnType<typeof setInterval> | null = null;
  private map: ItalyFerryMap | null = null;
  private mapMounted = false;
  private readonly ferryByMmsi = new Map<string, TrackedFerry>();

  constructor() {
    super({ id: 'italy-ferries', title: 'Italy Freight', showCount: true });
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
      if (this.mode === 'ports') await this.refreshPorts();
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

  private async refreshPorts(): Promise<void> {
    try {
      this.ports = await getPortStatus();
    } catch {
      /* keep the last-known port list */
    }
  }

  private render(): void {
    // Only the vessels view has nothing to show when no ferries match; the ports
    // view still renders the curated port list with zero counts.
    if (this.mode === 'vessels' && this.ferries.length === 0) {
      this.teardownMap();
      this.content.innerHTML = '<div class="economic-empty">No Italian ferries currently in view.</div>';
      return;
    }

    this.ensureScaffold();

    // Index by MMSI so a table-row click can focus the matching vessel on the map.
    this.ferryByMmsi.clear();
    for (const f of this.ferries) this.ferryByMmsi.set(f.mmsi, f);

    this.map?.setFerries(this.ferries);
    this.renderBoard();
  }

  private renderBoard(): void {
    const board = this.content.querySelector('.ferry-board');
    if (!board) return;
    board.innerHTML = this.mode === 'ports' ? this.portsTableHtml() : this.vesselsTableHtml();
  }

  private vesselsTableHtml(): string {
    // Group by destination island group (fallback bucket for unresolved).
    const groups = new Map<string, TrackedFerry[]>();
    for (const f of this.ferries) {
      const key = f.destinationGroup || (f.destinationName ? 'Other destinations' : 'Destination unknown');
      const bucket = groups.get(key) ?? [];
      bucket.push(f);
      groups.set(key, bucket);
    }

    // One table with group header rows, so every column lines up across groups.
    const body = [...groups.entries()].map(([group, ferries]) => {
      const groupRow = `<tr class="ferry-group-row"><td colspan="6">${escapeHtml(group)} <span class="ferry-group-count">${ferries.length}</span></td></tr>`;
      const rows = ferries.map((f) => {
        const operator = f.operatorName ? escapeHtml(f.operatorName) : '—';
        const destBadge = f.routeStatus === 'confirmed' ? ' <span class="ferry-route-ok" title="Scheduled route">✓</span>'
          : f.routeStatus === 'unknown' && f.destinationName ? ' <span class="ferry-route-warn" title="Off-schedule / unverified route">!</span>'
          : '';
        const dest = f.destinationName ? `${escapeHtml(f.destinationName)}${destBadge}` : 'unknown';
        const delayText = formatFerryDelay(f);
        const delayBadge = delayText ? ` <span class="ferry-delay-badge" title="Predicted arrival slipping vs recent trend">${escapeHtml(delayText)}</span>` : '';
        return `<tr data-mmsi="${escapeHtml(f.mmsi)}" title="Show on map">
          <td class="ferry-name">${escapeHtml(f.name)}</td>
          <td class="ferry-operator">${operator}</td>
          <td><span class="ferry-status ${STATUS_CLASS[f.status]}">${FERRY_STATUS_LABEL[f.status]}</span></td>
          <td class="ferry-dest">${dest}</td>
          <td class="ferry-speed">${escapeHtml(formatFerrySpeed(f))}</td>
          <td class="ferry-eta">${escapeHtml(formatFerryEta(f))}${delayBadge}</td>
        </tr>`;
      }).join('');
      return groupRow + rows;
    }).join('');

    return `<table class="ferry-table">
      <thead><tr>
        <th>Vessel</th><th>Operator</th><th>Status</th><th>Destination</th><th>Speed</th><th>ETA</th>
      </tr></thead>
      <tbody>${body}</tbody>
    </table>`;
  }

  private portsTableHtml(): string {
    if (this.ports.length === 0) {
      return '<div class="economic-empty">Port status unavailable.</div>';
    }
    const rows = this.ports.map((p) => `
      <tr>
        <td class="ferry-name">${escapeHtml(p.name)}</td>
        <td>${escapeHtml(p.region ?? '—')}</td>
        <td><span class="port-congestion port-congestion-${p.congestion}">${CONGESTION_LABEL[p.congestion]}</span></td>
        <td>${p.atPort}</td>
        <td>${p.inbound}</td>
      </tr>`).join('');
    return `<table class="ferry-table port-table">
      <thead><tr>
        <th>Port</th><th>Region</th><th>Status</th><th title="Freight vessels waiting / berthed within ~8 km">At port</th><th title="Freight vessels under way, bound here">Inbound</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  }

  /**
   * Build the persistent map host + toggle + table container once, synchronously
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
      <div class="ferry-toggle" role="tablist">
        <button type="button" class="ferry-toggle-btn" data-mode="vessels">Vessels</button>
        <button type="button" class="ferry-toggle-btn" data-mode="ports">Ports</button>
      </div>
      <div class="ferry-board"></div>
      <div class="economic-footer">
        <span class="economic-source">Source: AIS · ~ = inferred from course · ports = our curated freight ports</span>
      </div>
    `;
    const host = this.content.querySelector<HTMLElement>('.ferry-map-host');
    if (host) this.map = new ItalyFerryMap(host);

    // Mode toggle.
    const toggle = this.content.querySelector<HTMLElement>('.ferry-toggle');
    toggle?.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>('button[data-mode]');
      const mode = btn?.dataset.mode as BoardMode | undefined;
      if (!mode || mode === this.mode) return;
      this.mode = mode;
      this.updateToggleActive();
      if (mode === 'ports') {
        void this.refreshPorts().then(() => this.renderBoard());
      } else {
        this.renderBoard();
      }
    });
    this.updateToggleActive();

    // Click a vessel row to fly to it on the map (delegated, survives innerHTML swaps).
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

  private updateToggleActive(): void {
    const btns = this.content.querySelectorAll<HTMLElement>('.ferry-toggle-btn');
    btns.forEach((b) => b.classList.toggle('is-active', b.dataset.mode === this.mode));
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
