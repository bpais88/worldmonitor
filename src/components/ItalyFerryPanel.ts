import { Panel } from './Panel';
import { escapeHtml } from '@/utils/sanitize';
import { ItalyFerryMap } from './ItalyFerryMap';
import {
  getTrackedFreightVessels,
  type TrackedFerry,
  type FerryStatus,
} from '@/services/logistics/ferry-tracker';
import { FERRY_STATUS_LABEL, formatFerryEta, formatFerrySpeed, formatFerryDelay } from '@/services/logistics/ferry-format';
import { getPortStatus, type PortStatus } from '@/services/logistics/port-status';
import {
  regionOf,
  bboxForRegion,
  REGION_LABELS,
  REGION_ORDER,
  type FreightRegion,
} from '@/config/italy-ferries';
import { getGeofences, type Geofence } from '@/services/logistics/geofences';
import { aisStreamProvider } from '@/services/logistics/providers/aisstream';
import { describeFreshness } from '@/services/logistics/freshness';

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
 * Live board of European freight vessels (Italy, UK, Spain, Netherlands) derived
 * from AIS, with a region filter and a Vessels/Ports toggle. Self-contained: call
 * start() after mounting to begin polling.
 */
export class ItalyFerryPanel extends Panel {
  private ferries: TrackedFerry[] = [];
  private ports: PortStatus[] = [];
  private mode: BoardMode = 'vessels';
  private region: FreightRegion = 'all'; // country filter, or 'all' = Europe-wide
  private operatorFilter: string | null = null; // operatorId, or null = all
  private zonesOn = false; // geofence overlay visible?
  private geofences: Geofence[] | null = null; // lazy-loaded on first toggle
  private searchText = '';
  private timer: ReturnType<typeof setInterval> | null = null;
  private map: ItalyFerryMap | null = null;
  private mapMounted = false;
  private readonly ferryByMmsi = new Map<string, TrackedFerry>();

  constructor() {
    super({ id: 'italy-ferries', title: 'European Freight', showCount: true });
  }

  public start(): void {
    void this.refresh();
    if (!this.timer) {
      this.timer = setInterval(() => void this.refresh(), REFRESH_INTERVAL_MS);
    }
  }

  public async refresh(): Promise<void> {
    try {
      const ferries = await getTrackedFreightVessels();
      this.ferries = ferries;
      // Freshness badge: "as of HH:MM:SS" normally, "warming up…" right after a relay
      // restart (count still filling), or "stale" if ingest has stalled.
      const { state, detail } = describeFreshness(aisStreamProvider.lastMeta);
      this.setDataBadge(state, detail);
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
    // Always build the scaffold (map + Vessels/Ports toggle) so the user can
    // switch to Ports even when zero freight vessels match — the Ports view still
    // shows the curated port list with counts.
    this.ensureScaffold();

    // Index by MMSI so a table-row click can focus the matching vessel on the map.
    this.ferryByMmsi.clear();
    for (const f of this.ferries) this.ferryByMmsi.set(f.mmsi, f);

    this.renderRegion();
  }

  /**
   * Push the current region's vessels to the map + board (and the headline count).
   * Computes the region slice ONCE and threads it through, so a refresh does a
   * single filter pass — not one per consumer. Shared by render() + the region click.
   * The map + count show every vessel in the region; operator/search filter the table.
   */
  private renderRegion(): void {
    const regional = this.regionFerries();
    this.setCount(regional.length);
    this.map?.setFerries(regional);
    this.renderBoard(regional);
  }

  /** Vessels within the selected region's bbox ('all' → the whole Europe-wide feed). */
  private regionFerries(): TrackedFerry[] {
    if (this.region === 'all') return this.ferries;
    return this.ferries.filter((f) => regionOf(f.lat, f.lon) === this.region);
  }

  private renderBoard(regional: TrackedFerry[] = this.regionFerries()): void {
    const board = this.content.querySelector('.ferry-board');
    if (!board) return;
    // The operator filter bar belongs to the vessels view only.
    const filterBar = this.content.querySelector<HTMLElement>('.ferry-filter');
    if (filterBar) filterBar.style.display = this.mode === 'ports' ? 'none' : '';

    if (this.mode === 'ports') { board.innerHTML = this.portsTableHtml(); return; }

    this.refreshChips(regional);
    const shown = this.filteredFerries(regional);
    this.setCount(shown.length);
    if (regional.length === 0) {
      const where = this.region === 'all' ? '' : ` in ${REGION_LABELS[this.region]}`;
      board.innerHTML = `<div class="economic-empty">No freight vessels currently in view${where}.</div>`;
      return;
    }
    if (shown.length === 0) {
      board.innerHTML = '<div class="economic-empty">No vessels match this filter.</div>';
      return;
    }
    board.innerHTML = this.vesselsTableHtml(shown);
  }

  /** Apply the operator chip + free-text search filters to a region's ferries. */
  private filteredFerries(regional: TrackedFerry[]): TrackedFerry[] {
    const q = this.searchText.trim().toLowerCase();
    return regional.filter((f) => {
      if (this.operatorFilter && f.operatorId !== this.operatorFilter) return false;
      if (q) {
        const hay = `${f.name} ${f.operatorName ?? ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }

  /** Rebuild operator chips from the operators present in the region's ferries. */
  private refreshChips(regional: TrackedFerry[]): void {
    const host = this.content.querySelector<HTMLElement>('.ferry-chips');
    if (!host) return;
    // One pass: collect operator names + tally counts together (avoids a filter per chip).
    const byId = new Map<string, string>();
    const counts = new Map<string, number>();
    for (const f of regional) {
      if (f.operatorId && f.operatorName) {
        byId.set(f.operatorId, f.operatorName);
        counts.set(f.operatorId, (counts.get(f.operatorId) ?? 0) + 1);
      }
    }
    const ops = [...byId.entries()].sort((a, b) => a[1].localeCompare(b[1]));
    const chip = (id: string | null, label: string, count: number) => {
      const active = (this.operatorFilter ?? null) === id ? ' is-active' : '';
      return `<button type="button" class="ferry-chip${active}" data-op="${id ?? ''}">${escapeHtml(label)}${count >= 0 ? ` <span class="ferry-chip-n">${count}</span>` : ''}</button>`;
    };
    const chips = [chip(null, 'All', regional.length)]
      .concat(ops.map(([id, name]) => chip(id, name, counts.get(id) ?? 0)));
    host.innerHTML = chips.join('');
  }

  private vesselsTableHtml(list: TrackedFerry[]): string {
    // Group by destination island group (fallback bucket for unresolved).
    const groups = new Map<string, TrackedFerry[]>();
    for (const f of list) {
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
    const ports = this.region === 'all'
      ? this.ports
      : this.ports.filter((p) => regionOf(p.lat, p.lon) === this.region);
    if (ports.length === 0) {
      return '<div class="economic-empty">Port status unavailable.</div>';
    }
    const rows = ports.map((p) => `
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
      <div class="ferry-regions" role="tablist">
        ${REGION_ORDER.map((r) => `<button type="button" class="ferry-region-btn" data-region="${r}">${escapeHtml(REGION_LABELS[r])}</button>`).join('')}
      </div>
      <div class="ferry-toggle" role="tablist">
        <button type="button" class="ferry-toggle-btn" data-mode="vessels">Vessels</button>
        <button type="button" class="ferry-toggle-btn" data-mode="ports">Ports</button>
      </div>
      <div class="ferry-filter">
        <input type="search" class="ferry-search" placeholder="Search vessel or operator…" aria-label="Search vessel or operator" />
        <div class="ferry-chips"></div>
      </div>
      <div class="ferry-map-host"></div>
      <div class="ferry-map-legend">
        <span><i style="background:#2fbf85"></i>Under way (arrow = heading)</span>
        <span><i style="background:#e0a032"></i>At anchor</span>
        <span><i style="background:#9aa0a6"></i>In port</span>
        <button type="button" class="ferry-zones-btn" aria-pressed="false" title="Show the port geofence zones on the map">◯ Port zones</button>
      </div>
      <div class="ferry-board"></div>
      <div class="economic-footer">
        <span class="economic-source">Source: AIS · ~ = inferred from course · ports = our curated freight ports</span>
      </div>
    `;
    const host = this.content.querySelector<HTMLElement>('.ferry-map-host');
    if (host) this.map = new ItalyFerryMap(host);

    // Region filter: scopes both views to one country (or the Europe-wide union),
    // and zooms the map to that region. Switching region clears the operator filter
    // (a carrier present in one country may be absent in another).
    const regions = this.content.querySelector<HTMLElement>('.ferry-regions');
    regions?.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>('button[data-region]');
      const region = btn?.dataset.region as FreightRegion | undefined;
      if (!region || region === this.region) return;
      this.region = region;
      this.operatorFilter = null;
      this.updateRegionActive();
      this.map?.fitBbox(bboxForRegion(region));
      this.renderRegion();
    });
    this.updateRegionActive();

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

    // Operator filter: free-text search (input persists, so focus/value survive
    // board re-renders) + operator chips (delegated click).
    const search = this.content.querySelector<HTMLInputElement>('.ferry-search');
    search?.addEventListener('input', () => {
      this.searchText = search.value;
      this.renderBoard();
    });
    const chips = this.content.querySelector<HTMLElement>('.ferry-chips');
    chips?.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>('button[data-op]');
      if (!btn) return;
      this.operatorFilter = btn.dataset.op ? btn.dataset.op : null;
      this.renderBoard();
    });

    // Click a vessel row to fly to it on the map (delegated, survives innerHTML swaps).
    const board = this.content.querySelector<HTMLElement>('.ferry-board');
    board?.addEventListener('click', (e) => {
      const row = (e.target as HTMLElement).closest<HTMLElement>('tr[data-mmsi]');
      const mmsi = row?.dataset.mmsi;
      if (!mmsi) return;
      const ferry = this.ferryByMmsi.get(mmsi);
      if (ferry) this.map?.focusFerry(ferry);
    });

    // Geofence "Zones" overlay toggle (lazy-loads the shapes on first show).
    const zonesBtn = this.content.querySelector<HTMLButtonElement>('.ferry-zones-btn');
    zonesBtn?.addEventListener('click', () => void this.toggleZones(zonesBtn));

    this.mapMounted = true;
  }

  /** Toggle the geofence zone overlay; fetch the shapes once on first show. */
  private async toggleZones(btn: HTMLButtonElement): Promise<void> {
    this.zonesOn = !this.zonesOn;
    btn.classList.toggle('is-active', this.zonesOn);
    btn.setAttribute('aria-pressed', String(this.zonesOn));
    if (this.zonesOn && !this.geofences) {
      try {
        this.geofences = await getGeofences();
        this.map?.setGeofences(this.geofences);
      } catch {
        // Revert the toggle if the shapes fail to load.
        this.zonesOn = false;
        btn.classList.remove('is-active');
        btn.setAttribute('aria-pressed', 'false');
        return;
      }
    }
    this.map?.setZonesVisible(this.zonesOn);
  }

  private updateToggleActive(): void {
    const btns = this.content.querySelectorAll<HTMLElement>('.ferry-toggle-btn');
    btns.forEach((b) => b.classList.toggle('is-active', b.dataset.mode === this.mode));
  }

  private updateRegionActive(): void {
    const btns = this.content.querySelectorAll<HTMLElement>('.ferry-region-btn');
    btns.forEach((b) => b.classList.toggle('is-active', b.dataset.region === this.region));
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
