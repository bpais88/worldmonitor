import { createRelayHandler } from './_relay.js';

export const config = { runtime: 'edge' };

// Geofence zone shapes (one circle per commercial port) for the ferry.html "Zones"
// overlay. Static-ish — cached long. No query params.
export default createRelayHandler({
  relayPath: '/ais/geofences',
  timeout: 12000,
  requireApiKey: true,
  requireRateLimit: true,
  cacheHeaders: (ok) => ({
    'Cache-Control': ok
      ? 'public, max-age=300, s-maxage=600, stale-while-revalidate=1800, stale-if-error=3600'
      : 'public, max-age=30, s-maxage=60',
    ...(ok && { 'CDN-Cache-Control': 'public, s-maxage=600, stale-while-revalidate=1800' }),
  }),
});
