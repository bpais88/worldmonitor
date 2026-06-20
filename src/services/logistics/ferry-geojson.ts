// Pure conversion of tracked ferries -> GeoJSON for the MapLibre source.
//
// Deliberately free of any maplibre import so it stays unit-testable under the
// tsx node test runner (which has no DOM/WebGL).

import type { TrackedFerry } from './ferry-tracker';

export interface FerryFeatureProps {
  name: string;
  status: string;
  /** True when under way with a known course (drawn as a rotated arrow). */
  moving: boolean;
  /** Compass heading in degrees (0 when unknown). */
  courseDeg: number;
  speedKnots: number | null;
  destinationName: string | null;
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

export function ferriesToGeoJSON(ferries: TrackedFerry[]): FerryFeatureCollection {
  return {
    type: 'FeatureCollection',
    features: ferries.map((f) => ({
      type: 'Feature',
      // GeoJSON is [lon, lat] — order matters.
      geometry: { type: 'Point', coordinates: [f.lon, f.lat] },
      properties: {
        name: f.name,
        status: f.status,
        moving: f.status === 'under_way' && typeof f.courseDeg === 'number',
        courseDeg: typeof f.courseDeg === 'number' ? f.courseDeg : 0,
        speedKnots: typeof f.speedKnots === 'number' ? f.speedKnots : null,
        destinationName: f.destinationName ?? null,
      },
    })),
  };
}
