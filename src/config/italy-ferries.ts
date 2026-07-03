// Curated dataset for the freight-vessel board.
//
// Covers the major container/cargo ports of Italy, the UK, Spain and the
// Netherlands (plus, for Italy, the island destinations its ferries serve),
// the operators/carriers (for AIS name matching), and a representative set of
// Italian scheduled routes. Coordinates are terminal/harbour approximations.
//
// The board started Italy-only ("mainland -> Italian islands": Sardinia, Sicily,
// Elba, Aeolian, Bay of Naples, …) and was widened to Western Europe; the file
// name is kept for now to avoid churning the relay's require() path.
//
// The static ports + LOCODEs live in italy-ferries.data.json so the CommonJS
// relay (scripts/ferry-eta.cjs) and this TS app share ONE source of truth.

import ferryData from './italy-ferries.data.json';

/** A ferry terminal — a mainland gateway or an island destination. */
export interface FerryPort {
  id: string;
  name: string;
  lat: number;
  lon: number;
  /** 'mainland' = departure gateway; 'island' = island destination. */
  side: 'mainland' | 'island';
  /** Island group / region (for grouping island ports). */
  group?: string;
  /** Administrative region (matches Meteoalarm cap:areaDesc, e.g. "Campania", "Catalonia"). */
  region?: string;
  /** ISO country of the port — descriptive metadata ('IT' when absent). The region
   *  filter itself buckets by coordinate (see regionOf), not by this field. */
  country?: 'IT' | 'GB' | 'ES' | 'NL';
  /** True for a commercial freight port (vs an island/tourist terminal). */
  commercial?: boolean;
  /** Common AIS destination-field spellings (UPPERCASE) for text matching. */
  aisNames: string[];
}

/** A ferry operator / freight carrier and the keywords that appear in AIS vessel names. */
export interface FerryOperator {
  id: string;
  name: string;
  /** UPPERCASE substrings to match against an AIS ship name. */
  keywords: string[];
  /**
   * UPPERCASE fleet-name prefixes/suffixes (matched against the trimmed name). For lines whose
   * hulls never carry the company string — Evergreen's "EVER APEX", Grimaldi's "GRANDE TOGO",
   * DFDS's "PERGAMON SEAWAYS" — where a bare substring keyword would either never match or
   * false-positive mid-word ("EVER" is inside "CLEVER").
   */
  prefixes?: string[];
  suffixes?: string[];
  /** True for freight RoPax / RoRo lines (carry trucks/containers), not tourist. */
  freight?: boolean;
}

/** A scheduled mainland -> island connection (operator optional). */
export interface FerryRoute {
  fromId: string;
  toId: string;
  operatorId?: string;
}

/** A bounding box as [swLat, swLon, neLat, neLon]. */
export type Bbox = [number, number, number, number];

/** A covered country id, or 'all' for the Europe-wide union. */
export type FreightRegion = 'all' | 'it' | 'gb' | 'es' | 'nl';

/** Bounding box covering Italy + surrounding seas. */
export const ITALY_BBOX: Bbox = [35.0, 6.0, 46.5, 19.5];

/**
 * The covered countries, in selector display order. ONE source of truth — the
 * region label, its bbox, the selector order, and regionOf() all derive from
 * this table, so adding a country (e.g. France) is a single new row.
 * Each bbox is [swLat, swLon, neLat, neLon] and covers the surrounding seas.
 */
export const FREIGHT_REGIONS: ReadonlyArray<{
  id: Exclude<FreightRegion, 'all'>;
  label: string;
  bbox: Bbox;
}> = [
  { id: 'it', label: 'Italy', bbox: ITALY_BBOX },
  { id: 'gb', label: 'UK', bbox: [49.0, -11.0, 61.0, 2.5] },
  { id: 'es', label: 'Spain', bbox: [35.5, -10.0, 44.5, 4.5] },
  { id: 'nl', label: 'Netherlands', bbox: [50.5, 2.5, 54.0, 7.5] },
];

/** Union box across every covered country — the default ('all') board scope.
 *  Padded slightly beyond the exact union for edge margin + map framing. */
export const EUROPE_BBOX: Bbox = [34.0, -11.5, 61.0, 20.0];

/** Region ids in selector order, 'all' first. */
export const REGION_ORDER: FreightRegion[] = ['all', ...FREIGHT_REGIONS.map((r) => r.id)];

/** Region id → human label (incl. 'all'). */
export const REGION_LABELS: Record<FreightRegion, string> = {
  all: 'All',
  ...Object.fromEntries(FREIGHT_REGIONS.map((r) => [r.id, r.label])),
} as Record<FreightRegion, string>;

/** The bbox to query/zoom for a region ('all' → the Europe union). */
export function bboxForRegion(region: FreightRegion): Bbox {
  return FREIGHT_REGIONS.find((r) => r.id === region)?.bbox ?? EUROPE_BBOX;
}

/**
 * Which covered country a coordinate falls in, or null if outside all of them.
 * Used to filter the Europe-wide vessel/port feed down to a selected region
 * client-side (the boxes are near-disjoint, so first-match is unambiguous).
 */
export function regionOf(lat: number, lon: number): Exclude<FreightRegion, 'all'> | null {
  for (const r of FREIGHT_REGIONS) {
    const [s, w, n, e] = r.bbox;
    if (lat >= s && lat <= n && lon >= w && lon <= e) return r.id;
  }
  return null;
}

export const ITALY_FERRY_PORTS: FerryPort[] = ferryData.ports as unknown as FerryPort[];

/**
 * UN/LOCODE -> port id. Most ferries broadcast a LOCODE (e.g. "ITNAP") in the
 * AIS destination field rather than a port name, so name-only matching misses
 * them. Deliberately conservative: only codes verified against live traffic or
 * unambiguous major ports are listed — a wrong code shows a wrong destination,
 * which is worse than falling back to "unknown" / course inference.
 */
export const PORT_LOCODES: Record<string, string> = ferryData.locodes;

/**
 * Verified per-hull vessel types from Equasis (IMO -> { freight }). Distinguishes
 * "Passenger/Ro-Ro Cargo Ship" (freight) from "Passenger (Cruise) Ship" — the
 * RoPax-vs-cruise split AIS can't make. Populated manually (Equasis has no bulk
 * API); empty by default, overrides the operator heuristic when present.
 */
export const IMO_REGISTRY: Record<string, { freight: boolean }> =
  (ferryData as { imoRegistry?: Record<string, { freight: boolean }> }).imoRegistry ?? {};

export const ITALY_FERRY_OPERATORS: FerryOperator[] = ferryData.operators as unknown as FerryOperator[];

export const ITALY_FERRY_ROUTES: FerryRoute[] = [
  // Sardinia
  { fromId: 'civitavecchia', toId: 'olbia', operatorId: 'tirrenia' },
  { fromId: 'civitavecchia', toId: 'cagliari', operatorId: 'tirrenia' },
  { fromId: 'civitavecchia', toId: 'arbatax', operatorId: 'tirrenia' },
  { fromId: 'genoa', toId: 'porto_torres', operatorId: 'gnv' },
  { fromId: 'genoa', toId: 'olbia', operatorId: 'moby' },
  { fromId: 'livorno', toId: 'olbia', operatorId: 'moby' },
  { fromId: 'livorno', toId: 'golfo_aranci', operatorId: 'corsica_sardinia' },
  // Elba
  { fromId: 'piombino', toId: 'portoferraio', operatorId: 'toremar' },
  { fromId: 'piombino', toId: 'rio_marina', operatorId: 'blunavy' },
  { fromId: 'piombino', toId: 'cavo', operatorId: 'toremar' },
  // Sicily
  { fromId: 'naples', toId: 'palermo', operatorId: 'gnv' },
  { fromId: 'genoa', toId: 'palermo', operatorId: 'gnv' },
  { fromId: 'villa_san_giovanni', toId: 'messina', operatorId: 'caronte' },
  { fromId: 'naples', toId: 'cagliari', operatorId: 'tirrenia' },
  // Aeolian
  { fromId: 'milazzo', toId: 'lipari', operatorId: 'siremar' },
  { fromId: 'milazzo', toId: 'vulcano', operatorId: 'liberty_lines' },
  { fromId: 'naples', toId: 'stromboli', operatorId: 'snav' },
  // Bay of Naples
  { fromId: 'naples', toId: 'capri', operatorId: 'caremar' },
  { fromId: 'naples', toId: 'ischia', operatorId: 'caremar' },
  { fromId: 'naples', toId: 'procida', operatorId: 'caremar' },
  // Egadi / Pelagie / Pantelleria
  { fromId: 'trapani', toId: 'favignana', operatorId: 'liberty_lines' },
  { fromId: 'trapani', toId: 'marettimo', operatorId: 'liberty_lines' },
  { fromId: 'porto_empedocle', toId: 'lampedusa', operatorId: 'siremar' },
  { fromId: 'trapani', toId: 'pantelleria', operatorId: 'siremar' },
  // Other
  { fromId: 'palermo', toId: 'ustica', operatorId: 'siremar' },
  { fromId: 'termoli', toId: 'tremiti', operatorId: 'siremar' },
];
