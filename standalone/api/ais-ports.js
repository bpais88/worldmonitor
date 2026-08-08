import { createRelayHandler } from './_relay.js';

export const config = { runtime: 'edge' };

// Per-port freight congestion (curated commercial ports x live freight vessels).
// No query params — the relay computes status for all commercial ports.
export default createRelayHandler({
  relayPath: '/ais/ports',
  timeout: 12000,
  requireApiKey: true,
  requireRateLimit: true,
  cacheHeaders: (ok) => ({
    'Cache-Control': ok
      ? 'public, max-age=30, s-maxage=60, stale-while-revalidate=180, stale-if-error=300'
      : 'public, max-age=10, s-maxage=30, stale-while-revalidate=60',
    ...(ok && { 'CDN-Cache-Control': 'public, s-maxage=60, stale-while-revalidate=180, stale-if-error=300' }),
  }),
});
