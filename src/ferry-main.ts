// Standalone entry for the Italy Ferry Tracker demo page (ferry.html).
// Mounts just the ferry board — isolated from the main dashboard.

import 'maplibre-gl/dist/maplibre-gl.css';
import { ItalyFerryPanel } from '@/components/ItalyFerryPanel';
import { initI18n } from '@/services/i18n';

async function main(): Promise<void> {
  // The main app inits i18n during bootstrap; this standalone page must do it
  // itself, otherwise t() returns undefined (e.g. the panel's "Live" badge).
  await initI18n();

  const app = document.getElementById('app');
  if (app) {
    const panel = new ItalyFerryPanel();
    app.appendChild(panel.getElement());
    panel.start();
  }
}

void main();
