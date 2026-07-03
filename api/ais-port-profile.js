import { createRelayHandler } from './_relay.js';

export const config = { runtime: 'edge' };

// Phase C get_port_profile: one port's identity + coverage (always) + gated 45d arrival stats +
// live relative congestion, by ?port= (port_id). requireApiKey IS the paywall — profiles are
// authenticated (paid), not a free public API. The relay computes the field-level gate (single-gate
// in db.cjs); this proxy just forwards.
export default createRelayHandler({
  relayPath: '/ais/port-profile',
  timeout: 12000,
  requireApiKey: true,
  requireRateLimit: true,
  // Live congestion moves with the 5-min snapshot cadence → shorter cache than the vessel profile.
  cacheHeaders: (ok) => ({
    'Cache-Control': ok
      ? 'public, max-age=60, s-maxage=120, stale-while-revalidate=600, stale-if-error=600'
      : 'public, max-age=5, s-maxage=15',
  }),
});
