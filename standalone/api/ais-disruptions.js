import { createRelayHandler } from './_relay.js';

export const config = { runtime: 'edge' };

// M3: upcoming/reported strike + disruption events (official registries, union news, GDELT), by
// ?country= and/or ?port=. Same auth model as the profile surface: requireApiKey IS the paywall,
// trusted browser origins pass keyless. The relay merges/filters; this proxy just forwards.
export default createRelayHandler({
  relayPath: '/ais/disruptions',
  timeout: 12000,
  requireApiKey: true,
  requireRateLimit: true,
  // Slow-moving data (3h relay refresh) → a comfortable cache.
  cacheHeaders: (ok) => ({
    'Cache-Control': ok
      ? 'public, max-age=300, s-maxage=900, stale-while-revalidate=3600, stale-if-error=3600'
      : 'public, max-age=5, s-maxage=15',
  }),
});
