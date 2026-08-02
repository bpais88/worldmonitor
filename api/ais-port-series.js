import { createRelayHandler } from './_relay.js';

export const config = { runtime: 'edge' };

// Columnar per-port congestion series for the freight board's replay scrubber.
// ?hours= (default 48, max 168), ?ports=a,b, ?fields=atBerth,atPort, ?stepMin= (default 15).
//
// Deliberately NOT /ais/port-history: that endpoint serves the same underlying rows in a
// row-oriented shape built for baseline/backtest consumers. Measured on a real 48h window it is
// 0.29 MB gzipped — half of it port_events the replay never reads — against 7 KB for this one.
//
// requireApiKey IS the paywall, same as the port profile: history is authenticated, not a free
// public API. Moves with the 5-min snapshot cadence → short cache.
export default createRelayHandler({
  relayPath: '/ais/port-series',
  timeout: 15000,
  requireApiKey: true,
  requireRateLimit: true,
  cacheHeaders: (ok) => ({
    'Cache-Control': ok
      ? 'public, max-age=60, s-maxage=120, stale-while-revalidate=600, stale-if-error=600'
      : 'public, max-age=5, s-maxage=15',
  }),
});
