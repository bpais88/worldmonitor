'use strict';

// COUNTRY-SOURCE REGISTRY — the single place that says, per covered country, where contextual
// "why" signals come from: news locale + local disruption vocabulary, the official weather-alert
// feed, and how alert areas map onto our ports. Everything source-shaped derives from here
// (explainer-news, explainer-meteoalarm, the M2+ port-context / strike explainers), so LAUNCHING A
// NEW COUNTRY = adding ports to italy-ferries.data.json + one complete entry here — and the parity
// test (country-sources.test.cjs) fails CI until the entry is complete. That is the parity
// invariant: no country ever ships with fewer sources than the others.
// Spec: assistant/DISRUPTION_SOURCES_SCOPE.md (M1).

// Shared English disruption vocabulary — every country's press mixes English into trade coverage.
const EN_DISRUPTION = [
  'cancel', 'delay', 'suspend', 'closed', 'blocked', 'disrupt', 'halt', 'stop', 'congestion', 'accident',
];
const EN_STRIKE = ['strike', 'walkout', 'industrial action'];

const COUNTRY_SOURCES = {
  IT: {
    name: 'Italy',
    // Google News RSS locale + the freight noun that anchors the query in the local press.
    news: { hl: 'it', gl: 'IT', ceid: 'IT:it', freightNoun: 'porto traghetti' },
    strikeTerms: [...EN_STRIKE, 'sciopero'],
    disruptionTerms: [...EN_DISRUPTION, 'cancell', 'ritard', 'sospes', 'sospeso', 'maltempo', 'mareggiata', 'chiuso', 'chiusura', 'bloccat', 'incidente'],
    meteoalarmFeed: 'https://feeds.meteoalarm.org/feeds/meteoalarm-legacy-atom-italy',
    // Strike sources (M3): IT additionally has the official MIT registry (strike-sources.cjs);
    // unions here feed the curated union-news layer every country gets.
    strikeSources: { officialFeed: 'mit-scioperi', unions: ['Filt Cgil', 'Fit Cisl', 'Uiltrasporti', 'USB Lavoro Privato'] },
    // Meteoalarm Italy publishes areaDesc at ADMIN-REGION level, matching our ports' `region`
    // (keywords are substring-matched, lowercased + accent-folded, against areaDesc).
    alertAreaKeywordsByRegion: {
      'Calabria': ['calabria'], 'Campania': ['campania'], 'Emilia e Romagna': ['emilia'],
      'Friuli Venezia Giulia': ['friuli'], 'Liguria': ['liguria'], 'Marche': ['marche'],
      'Puglia': ['puglia'], 'Sardegna': ['sardegna'], 'Sicilia': ['sicilia'],
      'Toscana': ['toscana'], 'Veneto': ['veneto'],
    },
  },
  GB: {
    name: 'UK',
    news: { hl: 'en-GB', gl: 'GB', ceid: 'GB:en', freightNoun: 'port freight' },
    strikeTerms: [...EN_STRIKE, 'picket'],
    disruptionTerms: [...EN_DISRUPTION, 'shut', 'closure', 'stoppage', 'backlog', 'queue'],
    meteoalarmFeed: 'https://feeds.meteoalarm.org/feeds/meteoalarm-legacy-atom-united-kingdom',
    strikeSources: { unions: ['RMT', 'Unite the Union'] },
    // UK areaDesc granularity is county/Met-region; our port rows all say region "England",
    // so GB maps PER PORT (county + waterway keywords).
    alertAreaKeywordsByRegion: { 'England': [] }, // per-port overrides below carry GB
    alertAreaKeywordsByPort: {
      felixstowe: ['suffolk', 'east of england'],
      hull: ['yorkshire', 'humber'],
      immingham: ['lincolnshire', 'humber'],
      liverpool: ['merseyside', 'north west england'],
      london_gateway: ['essex', 'thames', 'london'],
      southampton: ['hampshire', 'solent', 'south east england'],
      teesport: ['tees', 'north east england', 'cleveland'],
      tilbury: ['essex', 'thames', 'london'],
    },
  },
  ES: {
    name: 'Spain',
    news: { hl: 'es', gl: 'ES', ceid: 'ES:es', freightNoun: 'puerto carga' },
    strikeTerms: [...EN_STRIKE, 'huelga', 'paro'],
    disruptionTerms: [...EN_DISRUPTION, 'cancelad', 'retras', 'suspend', 'cerrad', 'bloquead', 'temporal', 'accidente', 'colapso'],
    meteoalarmFeed: 'https://feeds.meteoalarm.org/feeds/meteoalarm-legacy-atom-spain',
    strikeSources: { unions: ['CCOO', 'UGT', 'Coordinadora Estibadores'] },
    // Meteoalarm Spain publishes SUB-PROVINCE zones ("Litoral de Barcelona", "Campiña gaditana"),
    // NOT admin regions — exact region matching would never fire. Keywords are the province/coast
    // names those zone labels actually contain for OUR ports.
    alertAreaKeywordsByRegion: {
      'Andalusia': ['cadiz', 'gaditan', 'estrecho'],          // Algeciras sits on the Strait, Cádiz province
      'Basque Country': ['bizkaia', 'vizcaya', 'bilbao'],
      'Catalonia': ['barcelona', 'tarragona'],
      'Galicia': ['pontevedra', 'rias baixas', 'vigo'],
      'Murcia': ['murcia', 'cartagena'],
      'Valencia': ['valencia'],
    },
  },
  PT: {
    name: 'Portugal',
    news: { hl: 'pt-PT', gl: 'PT', ceid: 'PT:pt-150', freightNoun: 'porto carga' },
    strikeTerms: [...EN_STRIKE, 'greve', 'paralisacao'],
    disruptionTerms: [...EN_DISRUPTION, 'cancelad', 'cancelament', 'atraso', 'suspens', 'encerrad', 'fechad', 'bloquead', 'temporal', 'acidente', 'congestionament'],
    meteoalarmFeed: 'https://feeds.meteoalarm.org/feeds/meteoalarm-legacy-atom-portugal',
    strikeSources: { unions: ['FECTRANS', 'Sindicato dos Estivadores', 'CGTP'] },
    // IPMA/Meteoalarm Portugal issues warnings by DISTRICT (distrito); areaDesc = district name.
    // Our port rows carry the NUTS-II region, so map each region to the district(s) its ports sit
    // in: Sines (Alentejo region) is administratively in the Setúbal district; Leixões (Norte) is
    // Porto district. Keywords are folded (lowercase, accent-free) to match foldText(areaDesc).
    alertAreaKeywordsByRegion: {
      'Alentejo': ['setubal', 'sines'],  // Sines → Setúbal district
      'Lisboa': ['lisboa'],
      'Norte': ['porto'],                // Leixões → Porto district
      'Setúbal': ['setubal'],
    },
  },
  NL: {
    name: 'Netherlands',
    news: { hl: 'nl', gl: 'NL', ceid: 'NL:nl', freightNoun: 'haven vracht' },
    strikeTerms: [...EN_STRIKE, 'staking', 'werkonderbreking'],
    disruptionTerms: [...EN_DISRUPTION, 'vertraging', 'gesloten', 'geblokkeerd', 'stremming', 'storing', 'ongeval', 'afgelast'],
    meteoalarmFeed: 'https://feeds.meteoalarm.org/feeds/meteoalarm-legacy-atom-netherlands',
    strikeSources: { unions: ['FNV Havens', 'FNV'] },
    // Meteoalarm NL areaDesc = provinces in Dutch; our ports carry English exonyms.
    alertAreaKeywordsByRegion: {
      'Groningen': ['groningen'],
      'North Brabant': ['noord-brabant'],
      'North Holland': ['noord-holland'],
      'South Holland': ['zuid-holland'],
      'Zeeland': ['zeeland'],
    },
  },
};

/** Registry entry for a country code ('IT' default — Italian ports carry no country field). */
function sourcesFor(country) {
  return COUNTRY_SOURCES[country || 'IT'] || null;
}

/** Lowercase + strip accents, so 'Cádiz' matches 'cadiz' (feeds and our keywords both fold). */
function foldText(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/**
 * The alert-area keywords for one port row ({ id, country, region }): per-port override first
 * (GB), else the country's region mapping. Empty array = this port cannot match any official
 * weather alert — the parity test treats that as a launch blocker.
 */
function alertAreaKeywordsFor(port) {
  const src = sourcesFor(port && port.country);
  if (!src) return [];
  const byPort = src.alertAreaKeywordsByPort && src.alertAreaKeywordsByPort[port.id];
  if (Array.isArray(byPort) && byPort.length) return byPort;
  const byRegion = src.alertAreaKeywordsByRegion && src.alertAreaKeywordsByRegion[port.region];
  return Array.isArray(byRegion) ? byRegion : [];
}

/** All strike+disruption terms for a country (the news matcher's vocabulary). */
function disruptionVocabularyFor(country) {
  const src = sourcesFor(country);
  if (!src) return { strikeTerms: EN_STRIKE, disruptionTerms: EN_DISRUPTION };
  return { strikeTerms: src.strikeTerms, disruptionTerms: src.disruptionTerms };
}

module.exports = { COUNTRY_SOURCES, sourcesFor, alertAreaKeywordsFor, disruptionVocabularyFor, foldText };
