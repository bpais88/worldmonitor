// Pure conversion of tracked ferries -> GeoJSON for the MapLibre source.
//
// Deliberately free of any maplibre import so it stays unit-testable under the
// tsx node test runner (which has no DOM/WebGL).

import type { TrackedFerry } from './ferry-tracker';
import {
  FERRY_STATUS_LABEL,
  formatFerryEta,
  formatFerrySpeed,
  formatFerrySize,
  formatFerryDraught,
  formatFerryDelay,
} from './ferry-format';

export interface FerryFeatureProps {
  mmsi: string;
  name: string;
  status: string;
  /** True when under way with a known course (drawn as a rotated arrow). */
  moving: boolean;
  /** Compass heading in degrees (0 when unknown). */
  courseDeg: number;
  // Display fields shared by the table and the map popup.
  operatorName: string;
  statusLabel: string;
  destinationName: string;
  speedText: string;
  etaText: string;
  sizeText: string;
  draughtText: string;
  callSign: string;
  etaAisText: string;
  /** '', 'Delayed +N min', or 'Stalled'. */
  delayText: string;
}

export interface FerryFeature {
  type: 'Feature';
  geometry: { type: 'Point'; coordinates: [number, number] };
  properties: FerryFeatureProps;
}

export interface FerryFeatureCollection {
  type: 'FeatureCollection';
  features: FerryFeature[];
}

/** The property bag for one ferry — shared by the source features and popups. */
export function ferryProps(f: TrackedFerry): FerryFeatureProps {
  return {
    mmsi: f.mmsi,
    name: f.name,
    status: f.status,
    moving: f.status === 'under_way' && typeof f.courseDeg === 'number',
    courseDeg: typeof f.courseDeg === 'number' ? f.courseDeg : 0,
    operatorName: f.operatorName ?? '',
    statusLabel: FERRY_STATUS_LABEL[f.status],
    destinationName: f.destinationName ?? '',
    speedText: formatFerrySpeed(f),
    etaText: formatFerryEta(f),
    sizeText: formatFerrySize(f),
    draughtText: formatFerryDraught(f),
    callSign: f.callSign ?? '',
    etaAisText: f.etaAis ?? '',
    delayText: formatFerryDelay(f),
  };
}

export function ferriesToGeoJSON(ferries: TrackedFerry[]): FerryFeatureCollection {
  return {
    type: 'FeatureCollection',
    features: ferries.map((f) => ({
      type: 'Feature',
      // GeoJSON is [lon, lat] — order matters.
      geometry: { type: 'Point', coordinates: [f.lon, f.lat] },
      properties: ferryProps(f),
    })),
  };
}
