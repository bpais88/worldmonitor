import { createRelayHandler } from './_relay.js';

export const config = { runtime: 'edge' };

// Phase C get_trip: one trip RECORD + its track, by ?id= (numeric trip id) or ?mmsi= (the vessel's
// latest/open leg). Query params forward to the relay automatically. requireApiKey IS the paywall —
// profiles are authenticated (paid), not a free public API. The relay computes the field-level gate.
export default createRelayHandler({
  relayPath: '/ais/trip',
  timeout: 12000,
  requireApiKey: true,
  requireRateLimit: true,
  // Proxy can't see terminal-vs-open, so a modest cache that's safe for a moving open trip; the relay
  // itself hard-caches immutable terminal trips on the relay→edge hop.
  cacheHeaders: (ok) => ({
    'Cache-Control': ok
      ? 'public, max-age=30, s-maxage=60, stale-while-revalidate=300, stale-if-error=300'
      : 'public, max-age=5, s-maxage=15',
  }),
});
