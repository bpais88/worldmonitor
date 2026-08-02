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
  formatFerryWhy,
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
  /** Likely-cause line, e.g. "🌊 Rough conditions…", or ''. */
  whyText: string;
  /**
   * How much this vessel deserves its name on the map. Higher wins.
   *
   * At the default European view ~3,000 vessels are on screen and only ~160 labels physically FIT.
   * MapLibre resolves that by feature order, so the 160 that got named were effectively arbitrary —
   * the map looked informative while telling you nothing in particular. This is the tie-break, so
   * the labels that survive are the ones a freight desk would ask for.
   */
  labelRank: number;
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

/**
 * Label priority. Ordered by what a freight desk actually looks for:
 *
 *   stalled           +100  a ship that has stopped moving is the story on this board
 *   slipping          +60   its ETA is drifting
 *   size              +0-12 bigger hulls carry more and matter more; unknown length scores 0
 *   under way         +2    a moving ship is more interesting than one parked at a berth
 *
 * Measured against the live feed: ranking leaves the label COUNT unchanged (~160 — collision
 * decides that) but lifts the average labelled vessel from 98m to 169m and under-way from 74 to 103.
 * Same ink, better chosen.
 */
function labelRankFor(f: TrackedFerry): number {
  let rank = 0;
  if (f.delay?.stalled) rank += 100;
  else if (f.delay?.slipping) rank += 60;
  if (Number.isFinite(f.lengthMeters)) rank += Math.min((f.lengthMeters as number) / 25, 12);
  if (f.status === 'under_way') rank += 2;
  return Math.round(rank * 10) / 10;
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
    labelRank: labelRankFor(f),
    whyText: formatFerryWhy(f),
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
