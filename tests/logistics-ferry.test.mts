import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { haversineKm, initialBearingDeg, bearingDeltaDeg, knotsToKmh } from '../src/services/logistics/geo.ts';
import { computeEta } from '../src/services/logistics/eta.ts';
import {
  isFerryShipType,
  matchItalianFerryOperator,
  isItalianFerry,
  matchDestinationPort,
  inferDestinationByCourse,
  estimateFerryEta,
} from '../src/services/logistics/ferry.ts';
import type { VesselPosition } from '../src/services/logistics/types.ts';

const CIVITAVECCHIA = { lat: 42.09, lon: 11.79 };
const OLBIA = { lat: 40.92, lon: 9.51 };

function vessel(overrides: Partial<VesselPosition>): VesselPosition {
  return {
    mmsi: '247000000',
    name: 'TEST FERRY',
    lat: 42.0,
    lon: 11.0,
    timestamp: 0,
    ...overrides,
  };
}

describe('geo', () => {
  it('haversineKm matches the known Civitavecchia->Olbia distance (~230km)', () => {
    const d = haversineKm(CIVITAVECCHIA, OLBIA);
    assert.ok(d > 215 && d < 245, `got ${d}`);
  });

  it('initialBearingDeg points east for a due-east target', () => {
    const b = initialBearingDeg({ lat: 0, lon: 0 }, { lat: 0, lon: 1 });
    assert.ok(Math.abs(b - 90) < 0.5, `got ${b}`);
  });

  it('bearingDeltaDeg handles wraparound', () => {
    assert.equal(bearingDeltaDeg(350, 10), 20);
    assert.equal(bearingDeltaDeg(10, 350), 20);
    assert.equal(bearingDeltaDeg(0, 180), 180);
  });

  it('knotsToKmh converts correctly', () => {
    assert.ok(Math.abs(knotsToKmh(10) - 18.52) < 1e-6);
  });
});

describe('ferry classification', () => {
  it('identifies passenger ship types 60-69', () => {
    assert.equal(isFerryShipType(60), true);
    assert.equal(isFerryShipType(69), true);
    assert.equal(isFerryShipType(70), false);
    assert.equal(isFerryShipType(undefined), false);
  });

  it('matches Italian operators by name', () => {
    assert.equal(matchItalianFerryOperator('MOBY DADA'), 'moby');
    assert.equal(matchItalianFerryOperator('GNV ATLAS'), 'gnv');
    assert.equal(matchItalianFerryOperator('CARONTE & TOURIST'), 'caronte');
    assert.equal(matchItalianFerryOperator('RANDOM CARGO'), undefined);
  });

  it('flags Italian-flag passenger vessels as ferries', () => {
    assert.equal(isItalianFerry({ name: 'UNKNOWN', shipType: 60, mmsi: '247123456' }), true);
    assert.equal(isItalianFerry({ name: 'GNV ATLAS', shipType: 70, mmsi: '999000000' }), true);
    assert.equal(isItalianFerry({ name: 'FOREIGN BOX', shipType: 70, mmsi: '999000000' }), false);
  });
});

describe('destination resolution', () => {
  it('matches AIS destination free-text to a port', () => {
    assert.equal(matchDestinationPort('OLBIA')?.id, 'olbia');
    assert.equal(matchDestinationPort('>PALERMO<')?.id, 'palermo');
    assert.equal(matchDestinationPort('GOLFO ARANCI')?.id, 'golfo_aranci');
    assert.equal(matchDestinationPort('NOWHERE'), undefined);
  });

  it('decodes UN/LOCODE destinations', () => {
    assert.equal(matchDestinationPort('ITNAP')?.id, 'naples');
    assert.equal(matchDestinationPort('ITGAI')?.id, 'golfo_aranci');
    assert.equal(matchDestinationPort('IT NAP')?.id, 'naples'); // spaced LOCODE
    assert.equal(matchDestinationPort('ITPRJ')?.id, 'capri');
  });

  it('resolves major commercial freight ports (LOCODE + name)', () => {
    assert.equal(matchDestinationPort('ITGIT')?.id, 'gioia_tauro');   // Italy's #1 container port
    assert.equal(matchDestinationPort('ITSPE')?.id, 'la_spezia');
    assert.equal(matchDestinationPort('ITTRS')?.id, 'trieste');
    assert.equal(matchDestinationPort('GIOIA TAURO')?.id, 'gioia_tauro'); // name fallback
    assert.equal(matchDestinationPort('LA SPEZIA')?.id, 'la_spezia');
    assert.equal(matchDestinationPort('MONFALCONE')?.id, 'monfalcone'); // name-only (no LOCODE)
  });

  it('resolves freight ports to their Meteoalarm region', () => {
    assert.equal(matchDestinationPort('ITGIT')?.region, 'Calabria');
    assert.equal(matchDestinationPort('ITTRS')?.region, 'Friuli Venezia Giulia');
    assert.equal(matchDestinationPort('ITRAN')?.region, 'Emilia e Romagna');
  });

  it('resolves multi-leg / round-trip strings to the final leg', () => {
    assert.equal(matchDestinationPort('ITFRD-ITISH-ITNAP')?.id, 'naples');
    assert.equal(matchDestinationPort('ITPOZ<>ITPRO')?.id, 'procida');
    assert.equal(matchDestinationPort('NAPOLI/CAPRI')?.id, 'capri');
    assert.equal(matchDestinationPort('ITNAP ITISH E VV')?.id, 'ischia');
  });

  it('returns undefined for ports outside the curated set', () => {
    assert.equal(matchDestinationPort('FRAJA'), undefined);  // Ajaccio (France)
    assert.equal(matchDestinationPort('HRSPU'), undefined);  // Split (Croatia) — out of scope
  });

  it('infers destination from course toward a nearby island', () => {
    // Just north of Portoferraio (Elba), steaming due south.
    const v = vessel({ lat: 42.88, lon: 10.31, courseDeg: 180, speedKnots: 18 });
    const inferred = inferDestinationByCourse(v);
    assert.equal(inferred?.port.id, 'portoferraio');
    assert.ok(inferred!.confidence > 0.2);
  });

  it('returns no inference without a course', () => {
    assert.equal(inferDestinationByCourse(vessel({ courseDeg: undefined })), undefined);
  });
});

describe('estimateFerryEta', () => {
  it('uses the AIS destination and computes a forward ETA', () => {
    const now = 1_700_000_000_000;
    const v = vessel({ ...CIVITAVECCHIA, destination: 'OLBIA', speedKnots: 20 });
    const eta = estimateFerryEta(v, now);
    assert.equal(eta?.destinationPortId, 'olbia');
    assert.equal(eta?.source, 'ais_destination');
    assert.ok(eta!.hoursRemaining! > 0);
    // ~230km at 20kn (~37km/h) => ~6h.
    assert.ok(eta!.hoursRemaining! > 5 && eta!.hoursRemaining! < 8, `got ${eta!.hoursRemaining}`);
    assert.equal(eta!.etaTimestamp, now + eta!.hoursRemaining! * 3_600_000);
  });

  it('returns a null ETA for a berthed (stopped) vessel', () => {
    const v = vessel({ ...CIVITAVECCHIA, destination: 'OLBIA', speedKnots: 0 });
    const eta = estimateFerryEta(v);
    assert.equal(eta?.destinationPortId, 'olbia');
    assert.equal(eta?.hoursRemaining, null);
    assert.equal(eta?.etaTimestamp, null);
  });
});
