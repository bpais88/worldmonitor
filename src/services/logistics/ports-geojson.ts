// Port congestion -> GeoJSON, for the map's Ports mode.
//
// WHY THIS EXISTS
// Per-port congestion is the signal the whole product is built around — ~345k snapshots, per-port
// day-of-week x hour baselines, the number Marco is told to LEAD with — and until now it appeared
// only in a table. Switching the board to "Ports" left the map showing vessels, so a user looking
// at the map could not see that Algeciras was congested with ten ships waiting.
//
// The properties below are chosen so the map can encode three separate things at once, which a
// single coloured dot cannot: HOW MANY are there (radius), HOW BUSY that is FOR THIS PORT (fill),
// and HOW MANY ARE QUEUED outside (ring).

import type { PortStatus, PortCongestion } from './port-status';

/** What the fill colour encodes. `unknown` is a first-class state, not a missing value. */
export type PortLevel = PortCongestion | 'unknown';

export interface PortFeatureProps {
  portId: string;
  name: string;
  /** The level the fill uses — see levelFor(). */
  level: PortLevel;
  atPort: number;
  atAnchor: number;
  atBerth: number;
  inbound: number;
  coverageOk: boolean;
  /** Pre-formatted for the label so the style doesn't have to do string maths. */
  label: string;
}

/**
 * The level a port should be DRAWN as.
 *
 * Two rules, both load-bearing:
 *
 * 1. No coverage wins over everything. `coverageOk: false` means no live feed can currently see
 *    this port, so its counts are last-known. Drawing that as "clear" is precisely the Lisbon bug
 *    (#125) — a blind spot rendered as a calm port. It gets its own visual treatment.
 * 2. Prefer `congestionRel` over `congestion`. The absolute label is measured against fleet-wide
 *    thresholds calibrated on Italian terminals, so it over-reads big ports (Rotterdam is
 *    near-permanently "congested") and under-reads small ones. congestionRel compares a port to its
 *    OWN dow x hour baseline, so it means the same thing everywhere. It is null until that port has
 *    ~3 weeks of history, and only then does the absolute label stand alone.
 */
export function levelFor(p: Pick<PortStatus, 'coverageOk' | 'congestion' | 'congestionRel'>): PortLevel {
  if (p.coverageOk === false) return 'unknown';
  return p.congestionRel ?? p.congestion ?? 'unknown';
}

function labelFor(p: PortStatus): string {
  if (p.coverageOk === false) return `${p.name} · no coverage`;
  const queue = p.atAnchor > 0 ? ` (${p.atAnchor} waiting)` : '';
  return `${p.name} · ${p.atPort}${queue}`;
}

/** FeatureCollection of port points. Ports without coordinates are skipped. */
export function portsToGeoJSON(ports: PortStatus[]): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];
  for (const p of ports || []) {
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon)) continue;
    const props: PortFeatureProps = {
      portId: p.portId,
      name: p.name,
      level: levelFor(p),
      atPort: p.atPort ?? 0,
      atAnchor: p.atAnchor ?? 0,
      atBerth: p.atBerth ?? 0,
      inbound: p.inbound ?? 0,
      coverageOk: p.coverageOk !== false,
      label: labelFor(p),
    };
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
      properties: props as unknown as GeoJSON.GeoJsonProperties,
    });
  }
  return { type: 'FeatureCollection', features };
}
