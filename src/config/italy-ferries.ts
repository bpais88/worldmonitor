// Curated dataset for Italian island-ferry tracking.
//
// Covers the mainland gateway ports and the island destinations they serve,
// the major operators (for AIS name matching), and a representative set of
// scheduled routes. Coordinates are terminal/harbour approximations.
//
// Scope is deliberately the demonstrable "mainland -> Italian islands" case:
// Sardinia, Sicily, Elba/Tuscan archipelago, Aeolian, Bay of Naples, Pontine,
// Egadi, Pelagie, Pantelleria, Ustica and Tremiti.

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
  /** Common AIS destination-field spellings (UPPERCASE) for text matching. */
  aisNames: string[];
}

/** An Italian ferry operator and the keywords that appear in AIS vessel names. */
export interface FerryOperator {
  id: string;
  name: string;
  /** UPPERCASE substrings to match against an AIS ship name. */
  keywords: string[];
}

/** A scheduled mainland -> island connection (operator optional). */
export interface FerryRoute {
  fromId: string;
  toId: string;
  operatorId?: string;
}

/** Bounding box covering Italy + surrounding seas: [swLat, swLon, neLat, neLon]. */
export const ITALY_BBOX: [number, number, number, number] = [35.0, 6.0, 46.5, 19.5];

export const ITALY_FERRY_PORTS: FerryPort[] = [
  // ---- Mainland gateways ----
  { id: 'genoa', name: 'Genoa', lat: 44.41, lon: 8.90, side: 'mainland', aisNames: ['GENOA', 'GENOVA'] },
  { id: 'civitavecchia', name: 'Civitavecchia', lat: 42.09, lon: 11.79, side: 'mainland', aisNames: ['CIVITAVECCHIA'] },
  { id: 'livorno', name: 'Livorno', lat: 43.55, lon: 10.30, side: 'mainland', aisNames: ['LIVORNO'] },
  { id: 'piombino', name: 'Piombino', lat: 42.93, lon: 10.52, side: 'mainland', aisNames: ['PIOMBINO'] },
  { id: 'naples', name: 'Naples', lat: 40.84, lon: 14.26, side: 'mainland', aisNames: ['NAPLES', 'NAPOLI'] },
  { id: 'salerno', name: 'Salerno', lat: 40.67, lon: 14.75, side: 'mainland', aisNames: ['SALERNO'] },
  { id: 'villa_san_giovanni', name: 'Villa San Giovanni', lat: 38.22, lon: 15.64, side: 'mainland', aisNames: ['VILLA S GIOVANNI', 'VILLA SAN GIOVANNI', 'VILLA S.G.'] },
  { id: 'reggio_calabria', name: 'Reggio Calabria', lat: 38.12, lon: 15.64, side: 'mainland', aisNames: ['REGGIO CALABRIA', 'REGGIO'] },
  { id: 'milazzo', name: 'Milazzo', lat: 38.22, lon: 15.24, side: 'mainland', group: 'Sicily', aisNames: ['MILAZZO'] },
  { id: 'trapani', name: 'Trapani', lat: 38.02, lon: 12.51, side: 'mainland', group: 'Sicily', aisNames: ['TRAPANI'] },
  { id: 'porto_empedocle', name: 'Porto Empedocle', lat: 37.29, lon: 13.53, side: 'mainland', group: 'Sicily', aisNames: ['PORTO EMPEDOCLE', 'EMPEDOCLE'] },
  { id: 'termoli', name: 'Termoli', lat: 42.00, lon: 14.99, side: 'mainland', aisNames: ['TERMOLI'] },

  // ---- Sardinia ----
  { id: 'olbia', name: 'Olbia', lat: 40.92, lon: 9.51, side: 'island', group: 'Sardinia', aisNames: ['OLBIA'] },
  { id: 'golfo_aranci', name: 'Golfo Aranci', lat: 41.00, lon: 9.62, side: 'island', group: 'Sardinia', aisNames: ['GOLFO ARANCI', 'ARANCI'] },
  { id: 'porto_torres', name: 'Porto Torres', lat: 40.84, lon: 8.40, side: 'island', group: 'Sardinia', aisNames: ['PORTO TORRES', 'P TORRES', 'TORRES'] },
  { id: 'cagliari', name: 'Cagliari', lat: 39.21, lon: 9.11, side: 'island', group: 'Sardinia', aisNames: ['CAGLIARI'] },
  { id: 'arbatax', name: 'Arbatax', lat: 39.94, lon: 9.70, side: 'island', group: 'Sardinia', aisNames: ['ARBATAX'] },

  // ---- Sicily ----
  { id: 'palermo', name: 'Palermo', lat: 38.14, lon: 13.37, side: 'island', group: 'Sicily', aisNames: ['PALERMO'] },
  { id: 'catania', name: 'Catania', lat: 37.50, lon: 15.09, side: 'island', group: 'Sicily', aisNames: ['CATANIA'] },
  { id: 'messina', name: 'Messina', lat: 38.19, lon: 15.57, side: 'island', group: 'Sicily', aisNames: ['MESSINA'] },

  // ---- Tuscan archipelago (Elba) ----
  { id: 'portoferraio', name: 'Portoferraio (Elba)', lat: 42.81, lon: 10.31, side: 'island', group: 'Tuscan Archipelago', aisNames: ['PORTOFERRAIO', 'P FERRAIO'] },
  { id: 'rio_marina', name: 'Rio Marina (Elba)', lat: 42.81, lon: 10.43, side: 'island', group: 'Tuscan Archipelago', aisNames: ['RIO MARINA'] },
  { id: 'cavo', name: 'Cavo (Elba)', lat: 42.86, lon: 10.42, side: 'island', group: 'Tuscan Archipelago', aisNames: ['CAVO'] },

  // ---- Aeolian Islands ----
  { id: 'lipari', name: 'Lipari', lat: 38.47, lon: 14.95, side: 'island', group: 'Aeolian', aisNames: ['LIPARI'] },
  { id: 'vulcano', name: 'Vulcano', lat: 38.41, lon: 14.96, side: 'island', group: 'Aeolian', aisNames: ['VULCANO'] },
  { id: 'salina', name: 'Salina', lat: 38.56, lon: 14.87, side: 'island', group: 'Aeolian', aisNames: ['SALINA', 'SANTA MARINA'] },
  { id: 'stromboli', name: 'Stromboli', lat: 38.79, lon: 15.21, side: 'island', group: 'Aeolian', aisNames: ['STROMBOLI'] },
  { id: 'panarea', name: 'Panarea', lat: 38.64, lon: 15.07, side: 'island', group: 'Aeolian', aisNames: ['PANAREA'] },

  // ---- Bay of Naples ----
  { id: 'capri', name: 'Capri', lat: 40.55, lon: 14.24, side: 'island', group: 'Bay of Naples', aisNames: ['CAPRI'] },
  { id: 'ischia', name: 'Ischia', lat: 40.73, lon: 13.95, side: 'island', group: 'Bay of Naples', aisNames: ['ISCHIA'] },
  { id: 'procida', name: 'Procida', lat: 40.76, lon: 14.04, side: 'island', group: 'Bay of Naples', aisNames: ['PROCIDA'] },

  // ---- Pontine Islands ----
  { id: 'ponza', name: 'Ponza', lat: 40.90, lon: 12.96, side: 'island', group: 'Pontine', aisNames: ['PONZA'] },
  { id: 'ventotene', name: 'Ventotene', lat: 40.79, lon: 13.43, side: 'island', group: 'Pontine', aisNames: ['VENTOTENE'] },

  // ---- Egadi Islands ----
  { id: 'favignana', name: 'Favignana', lat: 37.93, lon: 12.33, side: 'island', group: 'Egadi', aisNames: ['FAVIGNANA'] },
  { id: 'levanzo', name: 'Levanzo', lat: 38.00, lon: 12.34, side: 'island', group: 'Egadi', aisNames: ['LEVANZO'] },
  { id: 'marettimo', name: 'Marettimo', lat: 37.97, lon: 12.07, side: 'island', group: 'Egadi', aisNames: ['MARETTIMO'] },

  // ---- Pelagie Islands ----
  { id: 'lampedusa', name: 'Lampedusa', lat: 35.50, lon: 12.61, side: 'island', group: 'Pelagie', aisNames: ['LAMPEDUSA'] },
  { id: 'linosa', name: 'Linosa', lat: 35.86, lon: 12.87, side: 'island', group: 'Pelagie', aisNames: ['LINOSA'] },

  // ---- Other islands ----
  { id: 'pantelleria', name: 'Pantelleria', lat: 36.83, lon: 11.94, side: 'island', group: 'Sicily Channel', aisNames: ['PANTELLERIA'] },
  { id: 'ustica', name: 'Ustica', lat: 38.71, lon: 13.19, side: 'island', group: 'Tyrrhenian', aisNames: ['USTICA'] },
  { id: 'tremiti', name: 'Tremiti', lat: 42.12, lon: 15.49, side: 'island', group: 'Adriatic', aisNames: ['TREMITI', 'SAN DOMINO'] },
];

export const ITALY_FERRY_OPERATORS: FerryOperator[] = [
  { id: 'tirrenia', name: 'Tirrenia / CIN', keywords: ['TIRRENIA'] },
  { id: 'gnv', name: 'Grandi Navi Veloci', keywords: ['GNV', 'GRANDI NAVI VELOCI'] },
  { id: 'moby', name: 'Moby Lines', keywords: ['MOBY'] },
  { id: 'grimaldi', name: 'Grimaldi Lines', keywords: ['GRIMALDI'] },
  { id: 'corsica_sardinia', name: 'Corsica Sardinia Ferries', keywords: ['CORSICA', 'SARDINIA FERRIES'] },
  { id: 'caremar', name: 'Caremar', keywords: ['CAREMAR'] },
  { id: 'siremar', name: 'Siremar', keywords: ['SIREMAR'] },
  { id: 'liberty_lines', name: 'Liberty Lines', keywords: ['LIBERTY LINES', 'USTICA LINES'] },
  { id: 'snav', name: 'SNAV', keywords: ['SNAV'] },
  { id: 'toremar', name: 'Toremar', keywords: ['TOREMAR'] },
  { id: 'laziomar', name: 'Laziomar', keywords: ['LAZIOMAR'] },
  { id: 'alilauro', name: 'Alilauro', keywords: ['ALILAURO'] },
  { id: 'nlg', name: 'Navigazione Libera del Golfo', keywords: ['NLG', 'LIBERA DEL GOLFO'] },
  { id: 'blunavy', name: 'Blu Navy', keywords: ['BLU NAVY'] },
  { id: 'caronte', name: 'Caronte & Tourist', keywords: ['CARONTE', 'BLU JET'] },
];

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
