'use strict';

// Weather explainer: turns marine conditions at a vessel's position into a
// delay reason. Open-Meteo Marine + forecast are free + keyless. The pure
// interpretation (conditions -> reason) is unit-tested; fetch glue is thin.

const https = require('https');

// Ferry-relevant thresholds. Small island ferries / hydrofoils slow or cancel
// well before open-ocean limits, so these are conservative.
const WAVE_ROUGH_M = 2.5;     // rough -> high confidence
const WAVE_CHOPPY_M = 1.25;   // choppy -> moderate
const WIND_GALE_KTS = 34;     // gale -> high
const WIND_STRONG_KTS = 22;   // strong breeze -> moderate

/** Interpret marine conditions into a reason, or null when benign. Pure. */
function interpretMarineWeather(wx) {
  if (!wx) return null;
  const wave = Number.isFinite(wx.waveHeightM) ? wx.waveHeightM : null;
  const wind = Number.isFinite(wx.windKts) ? wx.windKts : null;
  if (wave == null && wind == null) return null;

  const rough = (wave != null && wave >= WAVE_ROUGH_M) || (wind != null && wind >= WIND_GALE_KTS);
  const choppy = (wave != null && wave >= WAVE_CHOPPY_M) || (wind != null && wind >= WIND_STRONG_KTS);
  if (!rough && !choppy) return null;

  const parts = [];
  if (wave != null) parts.push(`${wave.toFixed(1)} m seas`);
  if (wind != null) parts.push(`${Math.round(wind)} kt wind`);
  const detail = parts.join(', ');

  return {
    source: 'weather',
    kind: 'rough_seas',
    summary: rough ? `Rough conditions on the route (${detail})` : `Choppy conditions on the route (${detail})`,
    confidence: rough ? 0.85 : 0.55,
    detail,
  };
}

// Ferry-relevant visibility thresholds (metres). Hydrofoils especially slow or
// suspend in fog.
const VIS_FOG_M = 1000;   // fog -> high confidence
const VIS_POOR_M = 2000;  // poor visibility -> moderate

/** Interpret visibility into a reason, or null when clear/unknown. Pure. */
function interpretVisibility(visibilityM) {
  if (!Number.isFinite(visibilityM)) return null;
  if (visibilityM >= VIS_POOR_M) return null;
  const fog = visibilityM < VIS_FOG_M;
  const km = (visibilityM / 1000).toFixed(1);
  return {
    source: 'weather',
    kind: 'low_visibility',
    summary: fog ? `Fog / low visibility on the route (${km} km)` : `Poor visibility on the route (${km} km)`,
    confidence: fog ? 0.8 : 0.5,
    detail: `${Math.round(visibilityM)} m visibility`,
  };
}

function getJson(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: timeoutMs }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

const MS_TO_KTS = 1.94384;

/** Fetch marine wave height + wind at a position (Open-Meteo, keyless). */
async function fetchMarineWeather(lat, lon, timeoutMs = 8000) {
  const marineUrl = `https://marine-api.open-meteo.com/v1/marine?latitude=${lat.toFixed(2)}&longitude=${lon.toFixed(2)}&current=wave_height`;
  const windUrl = `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(2)}&longitude=${lon.toFixed(2)}&current=wind_speed_10m,wind_gusts_10m,visibility`;
  const [marine, wind] = await Promise.allSettled([
    getJson(marineUrl, timeoutMs),
    getJson(windUrl, timeoutMs),
  ]);
  const waveHeightM = marine.status === 'fulfilled' ? marine.value?.current?.wave_height : undefined;
  const windMs = wind.status === 'fulfilled' ? wind.value?.current?.wind_speed_10m : undefined;
  const gustMs = wind.status === 'fulfilled' ? wind.value?.current?.wind_gusts_10m : undefined;
  const visibilityM = wind.status === 'fulfilled' ? wind.value?.current?.visibility : undefined;
  return {
    waveHeightM: Number.isFinite(waveHeightM) ? waveHeightM : undefined,
    windKts: Number.isFinite(windMs) ? windMs * MS_TO_KTS : undefined,
    windGustKts: Number.isFinite(gustMs) ? gustMs * MS_TO_KTS : undefined, // crane-limit inference (port context)
    visibilityM: Number.isFinite(visibilityM) ? visibilityM : undefined,
  };
}

/** Explainer interface: explain(context) -> Reason[]. */
const weatherExplainer = {
  id: 'weather',
  async explain(ctx) {
    if (!Number.isFinite(ctx?.lat) || !Number.isFinite(ctx?.lon)) return [];
    const wx = await fetchMarineWeather(ctx.lat, ctx.lon);
    return [interpretMarineWeather(wx), interpretVisibility(wx.visibilityM)].filter(Boolean);
  },
};

module.exports = { interpretMarineWeather, interpretVisibility, fetchMarineWeather, weatherExplainer };
