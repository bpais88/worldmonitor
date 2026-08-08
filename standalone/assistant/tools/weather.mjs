// Marine weather tool — calls Open-Meteo directly (free, no API key). Resolves a
// port's coordinates from the relay's /ais/ports, then fetches wind + wave state.
import { relayGet } from '../relay.mjs';

async function findPort(port) {
  const j = await relayGet('/ais/ports');
  const q = String(port).toLowerCase();
  return (j.ports || []).find(
    (x) => x.name.toLowerCase() === q || String(x.portId).toLowerCase() === q || x.name.toLowerCase().includes(q),
  );
}

const num = (x) => (Number.isFinite(x) ? x : null);

export const weatherTools = [
  {
    name: 'get_marine_weather',
    description:
      'Current marine weather at a commercial freight port — wind speed/gusts (knots) and wave height (m). Use for "weather at Genoa", "is it rough near X", or to explain a delay.',
    input_schema: {
      type: 'object',
      properties: { port: { type: 'string', description: 'port name or id, e.g. "Genoa"' } },
      required: ['port'],
      additionalProperties: false,
    },
    handler: async ({ port }) => {
      const p = await findPort(port);
      if (!p) return { found: false, port };
      const windUrl = `https://api.open-meteo.com/v1/forecast?latitude=${p.lat}&longitude=${p.lon}&current=wind_speed_10m,wind_gusts_10m&wind_speed_unit=kn`;
      const marineUrl = `https://marine-api.open-meteo.com/v1/marine?latitude=${p.lat}&longitude=${p.lon}&current=wave_height`;
      const [w, m] = await Promise.all([
        fetch(windUrl).then((r) => r.json()).catch(() => null),
        fetch(marineUrl).then((r) => r.json()).catch(() => null),
      ]);
      return {
        found: true,
        port: p.name,
        windKn: num(w?.current?.wind_speed_10m),
        gustsKn: num(w?.current?.wind_gusts_10m),
        waveHeightM: num(m?.current?.wave_height),
      };
    },
  },
];
