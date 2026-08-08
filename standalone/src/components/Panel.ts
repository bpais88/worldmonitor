// Clean-room panel base for the standalone freight app.
//
// Written from the OBSERVED interface the freight components consume — constructor
// options {id,title,showCount}, a `content` mount point, setCount(), setDataBadge()/
// clearDataBadge(), getElement() — NOT from the upstream worldmonitor Panel (AGPL,
// multiple authors), which also carries drag-resize, collapse, error/retry and badge
// machinery this app never used. Class names (.panel-header etc.) are kept because
// index.html's stylesheet targets them; a class name is an interface, not expression.

export interface PanelOptions {
  id: string;
  title: string;
  showCount?: boolean;
}

type DataBadgeState = 'live' | 'cached' | 'unavailable';

const BADGE_LABELS: Record<DataBadgeState, string> = {
  live: 'Live',
  cached: 'Cached',
  unavailable: 'Unavailable',
};

export class Panel {
  private readonly root: HTMLElement;
  private countEl: HTMLElement | null = null;
  private readonly badgeEl: HTMLElement;
  /** The area subclasses render into. */
  protected readonly content: HTMLElement;

  constructor(options: PanelOptions) {
    this.root = document.createElement('div');
    this.root.className = 'panel';
    this.root.id = `panel-${options.id}`;

    const header = document.createElement('div');
    header.className = 'panel-header';

    const left = document.createElement('div');
    left.className = 'panel-header-left';

    const title = document.createElement('span');
    title.className = 'panel-title';
    title.textContent = options.title;
    left.appendChild(title);

    if (options.showCount) {
      const count = document.createElement('span');
      count.className = 'panel-count';
      left.appendChild(count);
      this.countEl = count;
    }

    this.badgeEl = document.createElement('span');
    this.badgeEl.className = 'panel-data-badge';
    this.badgeEl.style.display = 'none';

    header.appendChild(left);
    header.appendChild(this.badgeEl);

    this.content = document.createElement('div');
    this.content.className = 'panel-content';

    this.root.appendChild(header);
    this.root.appendChild(this.content);
  }

  public getElement(): HTMLElement {
    return this.root;
  }

  public setCount(count: number): void {
    if (!this.countEl) return;
    this.countEl.textContent = String(count);
  }

  /** Freshness badge: "Live", "Cached · 3m old", "Unavailable". */
  protected setDataBadge(state: DataBadgeState, detail?: string): void {
    this.badgeEl.textContent = detail ? `${BADGE_LABELS[state]} · ${detail}` : BADGE_LABELS[state];
    this.badgeEl.className = `panel-data-badge ${state}`;
    this.badgeEl.style.display = 'inline-flex';
  }

  protected clearDataBadge(): void {
    this.badgeEl.style.display = 'none';
  }

  public destroy(): void {
    this.root.remove();
  }
}
