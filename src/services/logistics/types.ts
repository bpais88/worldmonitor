// Logistics domain model — shipment-centric tracking (B2B).
//
// The tracked entity is a Shipment, which moves across one or more Legs
// (ocean / road / rail / air). Today only the ocean leg is wired to live
// data (AIS), but the model is multimodal so road/rail/air providers can be
// added later without reshaping the data.

/** Transport mode for a shipment leg. Ocean is the only mode wired today. */
export type TransportMode = 'ocean' | 'road' | 'rail' | 'air';

/** A geographic point. */
export interface LatLon {
  lat: number;
  lon: number;
}

/** AIS-derived live state for a vessel. */
export interface VesselPosition extends LatLon {
  mmsi: string;
  imo?: string;
  name: string;
  /** Speed over ground, knots. */
  speedKnots?: number;
  /** Course over ground, degrees (0-360). */
  courseDeg?: number;
  /** True heading, degrees (0-360). */
  headingDeg?: number;
  /** AIS ship type code (0-99). */
  shipType?: number;
  /** Free-text AIS destination field (crew-entered, often UPPERCASE). */
  destination?: string;
  /** Epoch ms of the position report. */
  timestamp: number;
}

export type MilestoneType =
  | 'booked'
  | 'departed'
  | 'in_transit'
  | 'arrived'
  | 'delivered'
  | 'exception';

export interface Milestone {
  type: MilestoneType;
  /** Epoch ms. */
  at: number;
  portId?: string;
  note?: string;
}

/** A single mode segment of a shipment (e.g. one ocean crossing). */
export interface ShipmentLeg {
  id: string;
  mode: TransportMode;
  originPortId: string;
  destinationPortId: string;
  /** Vessel carrying this leg, if known/assigned. */
  vesselMmsi?: string;
  vesselImo?: string;
  scheduledDeparture?: number;
  scheduledArrival?: number;
  milestones: Milestone[];
}

/** Top-level tracked entity: a customer shipment across one or more legs. */
export interface Shipment {
  id: string;
  /** Customer-facing reference (BL number, booking, PO). */
  reference: string;
  containerNumbers?: string[];
  legs: ShipmentLeg[];
  createdAt: number;
}

/** How a vessel's destination was determined, weakest to strongest. */
export type EtaSource = 'course_inference' | 'ais_destination' | 'scheduled' | 'manual';

/** Computed ETA result for an ocean leg. */
export interface EtaEstimate {
  destinationPortId: string;
  distanceKm: number;
  /** Hours remaining at current speed; null if speed unknown/stopped. */
  hoursRemaining: number | null;
  /** Epoch ms; null if not computable (e.g. vessel berthed). */
  etaTimestamp: number | null;
  /** How the destination was determined. */
  source: EtaSource;
  /** 0-1 confidence in the destination guess. */
  confidence: number;
}
