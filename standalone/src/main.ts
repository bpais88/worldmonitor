// Standalone entry for the European Freight Tracker page (ferry.html).
// Mounts just the freight board — isolated from the main dashboard.

import 'maplibre-gl/dist/maplibre-gl.css';
import { FreightPanel } from '@/components/FreightPanel';
import { initI18n } from '@/services/i18n';

const ABOUT_SEEN_KEY = 'seaosea-about-seen';

/**
 * The intro copy explains what Vessels / Ports / Disruptions actually contain, which is genuinely
 * useful the first time and pure furniture every time after — and it was costing the map ~42px on
 * every visit. So: expanded on the FIRST visit, collapsed from then on, and always one click away
 * behind the (i). Toggling it also updates the stored preference, so a reader who opens it keeps
 * it open.
 */
function wireAboutToggle(): void {
  const btn = document.getElementById('ferry-about-btn');
  const about = document.getElementById('ferry-about');
  if (!btn || !about) return;

  let seen = false;
  try { seen = localStorage.getItem(ABOUT_SEEN_KEY) === '1'; } catch { /* private mode */ }

  const apply = (open: boolean) => {
    about.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
  };
  apply(!seen);
  // Mark it seen on the first visit so the NEXT load starts collapsed — without this the intro
  // would be permanent for anyone who never touches the button.
  if (!seen) { try { localStorage.setItem(ABOUT_SEEN_KEY, '1'); } catch { /* ignore */ } }

  btn.addEventListener('click', () => apply(about.hidden));
}

async function main(): Promise<void> {
  // The main app inits i18n during bootstrap; this standalone page must do it
  // itself, otherwise t() returns undefined (e.g. the panel's "Live" badge).
  await initI18n();

  wireAboutToggle();

  const app = document.getElementById('app');
  if (app) {
    const panel = new FreightPanel();
    app.appendChild(panel.getElement());
    panel.start();
  }
}

void main();
