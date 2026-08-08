// Manual / CSV shipment entry + persistence (B2B side).
//
// At the prototype stage shipments are entered by hand or imported from CSV and
// kept in localStorage. The store is storage-injectable so the parsing and CRUD
// logic is unit-testable without a browser. A carrier-event API feed (Vizion,
// Terminal49, Project44) can later populate the same Shipment records.

import type { Shipment, ShipmentLeg } from './types';

/** Minimal storage surface (localStorage-compatible) for injection in tests. */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const STORAGE_KEY = 'worldmonitor_shipments_v1';

class MemoryStorage implements KeyValueStorage {
  private map = new Map<string, string>();
  getItem(key: string): string | null { return this.map.has(key) ? this.map.get(key)! : null; }
  setItem(key: string, value: string): void { this.map.set(key, value); }
}

function defaultStorage(): KeyValueStorage {
  try {
    if (typeof localStorage !== 'undefined') return localStorage;
  } catch { /* access denied — fall through */ }
  return new MemoryStorage();
}

function genId(): string {
  return `shp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Fields accepted when creating a shipment manually. */
export interface ShipmentInput {
  reference: string;
  containerNumbers?: string[];
  originPortId?: string;
  destinationPortId?: string;
  vesselImo?: string;
  vesselMmsi?: string;
}

function toShipment(input: ShipmentInput, now: number): Shipment {
  const leg: ShipmentLeg = {
    id: genId(),
    mode: 'ocean',
    originPortId: input.originPortId ?? '',
    destinationPortId: input.destinationPortId ?? '',
    vesselImo: input.vesselImo,
    vesselMmsi: input.vesselMmsi,
    milestones: [{ type: 'booked', at: now }],
  };
  return {
    id: genId(),
    reference: input.reference.trim(),
    containerNumbers: input.containerNumbers?.filter(Boolean),
    legs: [leg],
    createdAt: now,
  };
}

export class ShipmentStore {
  constructor(private readonly storage: KeyValueStorage = defaultStorage()) {}

  list(): Shipment[] {
    const raw = this.storage.getItem(STORAGE_KEY);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as Shipment[]) : [];
    } catch {
      return [];
    }
  }

  private persist(shipments: Shipment[]): void {
    this.storage.setItem(STORAGE_KEY, JSON.stringify(shipments));
  }

  add(input: ShipmentInput, now: number = Date.now()): Shipment {
    if (!input.reference || !input.reference.trim()) {
      throw new Error('Shipment reference is required');
    }
    const shipment = toShipment(input, now);
    const all = this.list();
    all.push(shipment);
    this.persist(all);
    return shipment;
  }

  remove(id: string): void {
    this.persist(this.list().filter((s) => s.id !== id));
  }

  clear(): void {
    this.persist([]);
  }

  importCsv(csv: string, now: number = Date.now()): Shipment[] {
    const inputs = parseShipmentCsv(csv);
    const all = this.list();
    const added: Shipment[] = [];
    for (const input of inputs) {
      const shipment = toShipment(input, now);
      all.push(shipment);
      added.push(shipment);
    }
    this.persist(all);
    return added;
  }
}

/**
 * Parse a CSV into ShipmentInputs. Expects a header row; recognised columns
 * (case-insensitive): reference, container, origin, destination, imo, mmsi.
 * Rows without a reference are skipped.
 */
export function parseShipmentCsv(csv: string): ShipmentInput[] {
  const lines = csv.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return [];

  const header = splitCsvLine(lines[0]!).map((h) => h.toLowerCase());
  const idx = (name: string): number => header.indexOf(name);
  const refIdx = idx('reference');
  const containerIdx = idx('container');
  const originIdx = idx('origin');
  const destIdx = idx('destination');
  const imoIdx = idx('imo');
  const mmsiIdx = idx('mmsi');

  const out: ShipmentInput[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = splitCsvLine(lines[i]!);
    const reference = refIdx >= 0 ? (cols[refIdx] ?? '').trim() : '';
    if (!reference) continue;
    const container = containerIdx >= 0 ? (cols[containerIdx] ?? '').trim() : '';
    out.push({
      reference,
      containerNumbers: container ? [container] : undefined,
      originPortId: originIdx >= 0 ? (cols[originIdx] ?? '').trim() || undefined : undefined,
      destinationPortId: destIdx >= 0 ? (cols[destIdx] ?? '').trim() || undefined : undefined,
      vesselImo: imoIdx >= 0 ? (cols[imoIdx] ?? '').trim() || undefined : undefined,
      vesselMmsi: mmsiIdx >= 0 ? (cols[mmsiIdx] ?? '').trim() || undefined : undefined,
    });
  }
  return out;
}

/** Split a single CSV line, honouring double-quoted fields. */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else { inQuotes = false; }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map((s) => s.trim());
}
