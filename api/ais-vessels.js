import { createRelayHandler } from './_relay.js';

export const config = { runtime: 'edge' };

// Individual commercial vessel positions inside a viewport (ferry/cargo/tanker).
// Query params (bbox, types, limit) are forwarded to the relay automatically.
export default createRelayHandler({
  relayPath: '/ais/vessels',
  timeout: 12000,
  requireApiKey: true,
  requireRateLimit: true,
  cacheHeaders: (ok) => ({
    'Cache-Control': ok
      ? 'public, max-age=15, s-maxage=30, stale-while-revalidate=120, stale-if-error=300'
      : 'public, max-age=5, s-maxage=15, stale-while-revalidate=60',
    ...(ok && { 'CDN-Cache-Control': 'public, s-maxage=30, stale-while-revalidate=120, stale-if-error=300' }),
  }),
});
