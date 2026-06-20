// Standalone entry for the Italy Ferry Tracker demo page (ferry.html).
// Mounts just the ferry board — isolated from the main dashboard.

import { ItalyFerryPanel } from '@/components/ItalyFerryPanel';

const app = document.getElementById('app');
if (app) {
  const panel = new ItalyFerryPanel();
  app.appendChild(panel.getElement());
  panel.start();
}
