import { createRelayHandler } from './_relay.js';

export const config = { runtime: 'edge' };

// Phase C get_vessel_profile: one vessel's identity (always) + gated 45d stats, by ?mmsi=.
// requireApiKey IS the paywall — profiles are authenticated (paid), not a free public API.
// The relay computes the field-level gate (single-gate in db.cjs); this proxy just forwards.
export default createRelayHandler({
  relayPath: '/ais/vessel-profile',
  timeout: 12000,
  requireApiKey: true,
  requireRateLimit: true,
  // Stats only move when a trip closes; identity is near-static → a modest cache is safe.
  cacheHeaders: (ok) => ({
    'Cache-Control': ok
      ? 'public, max-age=300, s-maxage=600, stale-while-revalidate=1800, stale-if-error=1800'
      : 'public, max-age=5, s-maxage=15',
  }),
});
