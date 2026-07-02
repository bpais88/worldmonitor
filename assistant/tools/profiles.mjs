// Phase C profile tools — get_trip ships first (get_vessel_profile / get_port_profile follow). All
// read-only, served by the relay's DB-backed /ais/* endpoints. The sufficiency gate / field flags are
// computed server-side (scripts/db.cjs), so this layer just relays the already-flagged payload — no
// re-derivation, no db import (stays on the clean HTTP boundary via relayGet).
import { relayGet } from '../relay.mjs';

export const profileTools = [
  {
    name: 'get_trip',
    description:
      'Look up ONE freight voyage (trip) as a record: origin/destination ports, opened/departed/arrived times, '
      + 'duration, great-circle distance, average speed, destination dwell, ETA slip, and route-track summary. '
      + 'Pass a numeric trip_id (e.g. from the freight board) OR an mmsi to get that vessel\'s latest/current leg. '
      + 'Immature fields carry a note in `notes` (e.g. "computing", "origin not observed; distance unavailable", '
      + '"sparse; N waypoints", "stale"). ALWAYS lead with any such note and never quote a noted field as settled. '
      + 'Scope: freight vessels to tracked EU commercial ports only. Read-only.',
    input_schema: {
      type: 'object',
      properties: {
        trip_id: { type: 'integer', description: 'numeric trip id' },
        mmsi: { type: 'string', description: "vessel MMSI — returns that vessel's latest/open leg" },
      },
      additionalProperties: false,
    },
    handler: async ({ trip_id, mmsi }) => {
      if (trip_id == null && !mmsi) return { found: false, error: 'provide trip_id or mmsi' };
      const qs = trip_id != null ? `id=${encodeURIComponent(trip_id)}` : `mmsi=${encodeURIComponent(mmsi)}`;
      try {
        const res = await relayGet(`/ais/trip?${qs}`);
        if (!res || res.found === false) return { found: false, ...(res && res.notes ? { notes: res.notes } : {}) };
        // Drop the full track array from the LLM payload (up to 5000 waypoints — the UI fetches the
        // endpoint directly for the map); keep the record + notes + track summary.
        const { track, ...rest } = res;
        return { ...rest, hasTrack: Array.isArray(track) && track.length > 0 };
      } catch {
        return { found: false, error: 'trip lookup failed' };
      }
    },
  },
];
