// Vessel data provider abstraction — the "free now, paid later" seam.
//
// AisStreamProvider (free aisstream.io via the relay) implements this today.
// SpireProvider / MarineTrafficProvider / DatalasticProvider can implement the
// same interface later for open-ocean coverage + enrichment, without the UI or
// the logistics engine changing.

import type { VesselPosition } from '../types';
import type { ShipCategory } from '../classify';

/** Delay status from the relay's ETA-drift detection (Method B). */
export interface VesselDelay {
  /** Predicted arrival is sliding later vs the recent trend. */
  slipping?: boolean;
  /** Stopped mid-crossing (not in port). */
  stalled?: boolean;
  /** How many minutes the predicted arrival moved later over the window. */
  etaGrowthMin?: number;
  windowMin?: number;
  samples?: number;
}

/** A live vessel position enriched with its coarse category. */
export interface LiveVessel extends VesselPosition {
  category: ShipCategory;
  /** AIS navigational status code (0=under way, 1=at anchor, 5=moored, ...). */
  navStatus?: number;
  /** Delay status computed by the relay, if available. */
  delay?: VesselDelay;
}

/** Viewport + filter for a vessel query. */
export interface VesselQuery {
  /** Bounding box as [swLat, swLon, neLat, neLon]. */
  bbox?: [number, number, number, number];
  /** Restrict to these coarse categories (e.g. ['passenger']). */
  categories?: ShipCategory[];
  /** Max vessels to return. */
  limit?: number;
}

/** Source of live vessel positions for the logistics engine. */
export interface VesselDataProvider {
  readonly id: string;
  /** Vessels currently inside the query viewport. */
  getVesselsInBounds(query: VesselQuery): Promise<LiveVessel[]>;
}
