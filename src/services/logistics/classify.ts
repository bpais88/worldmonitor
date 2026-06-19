// Coarse vessel categorisation from AIS ship-type codes. Kept tiny and pure so
// it can be shared between the relay-facing provider and the UI, and unit-tested
// in isolation. Mirrors the relay's shipTypeCategory() in scripts/ais-relay.cjs.

export type ShipCategory = 'passenger' | 'cargo' | 'tanker' | 'hsc' | 'other';

/**
 * Bucket an AIS ship type code (0-99) into a coarse commercial category.
 *  - 60-69 passenger (ferries)
 *  - 70-79 cargo
 *  - 80-89 tanker
 *  - 40-49 high-speed craft (many fast ferries)
 */
export function shipTypeCategory(shipType: number | undefined): ShipCategory {
  if (typeof shipType !== 'number' || !Number.isFinite(shipType)) return 'other';
  if (shipType >= 60 && shipType <= 69) return 'passenger';
  if (shipType >= 70 && shipType <= 79) return 'cargo';
  if (shipType >= 80 && shipType <= 89) return 'tanker';
  if (shipType >= 40 && shipType <= 49) return 'hsc';
  return 'other';
}
