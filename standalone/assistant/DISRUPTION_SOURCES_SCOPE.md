# Disruption Sources & Proactive Alerts — scope

Status: scoped 2026-07-05 with the owner. Goal: Marco stops saying *"my data just shows the
numbers"* — port answers carry sourced, hedged "why" context (strikes, weather closures,
accidents), with **source parity across countries as an invariant**, and eventually Marco tells
users about upcoming disruptions **before they ask**.

Owner decisions (2026-07-05): proactive alerts extend the EXISTING watches (a port watch also gets
that port's disruption alerts + Marco offers in conversation); strike sources = FULL curated set
now (not GDELT-only); build order M1 → M2 → M3 → M4.

## M1 — Country-source registry + parity guard (SHIPPED 2026-07-05)

`scripts/country-sources.cjs`: per covered country — Google News locale + freight noun,
local-language strike/disruption vocabulary, official weather-alert feed (Meteoalarm), and
**alert-area keywords** mapping feed `areaDesc` onto our ports (Italy publishes admin regions;
Spain publishes SUB-PROVINCE zones like "Litoral de Barcelona" — exact region matching never
fires there; NL publishes provinces in Dutch; GB granularity is county-ish → per-port overrides).
Matching is folded (lowercase, accent-stripped: Cádiz → cadiz).

Consumers refactored: `explainer-news.cjs` (locale + vocabulary per country — a Rotterdam strike
surfaces in Dutch press, previously invisible under the hardcoded `hl=it`), `explainer-meteoalarm.cjs`
(`fetchMeteoalarmAll()` — every registry country, warnings tagged by country, per-country failure
degrades to [] without poisoning the rest), relay ctx gains `destCountry`.

**The parity invariant** (`scripts/country-sources.test.cjs`, runs in test:relay CI): every country
with a commercial port must have a COMPLETE registry entry, and every commercial port must resolve
to ≥1 alert-area keyword. Launching a country = add ports → CI fails listing exactly what's
missing. The prose sibling (assistant/coverage.test.mjs) already guards Marco's coverage claims;
the voice channel's snapshot is guarded by the nightly voice-drift workflow (re-provision after
persona/tool changes).

## M2 — Port-context enrichment (NEXT)

`port-context` module assembling per busy port: news match (port + country locale), active
Meteoalarm warnings for the port's area, weather-operational inference (gusts above crane-stop
thresholds → "likely crane suspension"), own-data anomaly once baselines mature (at_berth vs
p90-for-this-dow×hour; dwell spike = "busy but stuck" vs "busy but flowing"). Relay-side cache
(TTL 30–60 min, computed for congested/busy ports + on demand for profiles); attached as
`context[] {source, kind, summary, confidence, url?, startsAt?}` to `/ais/ports` (busy rows) and
`/ais/port-profile`. Marco prompt rule: hedged causality — "possibly related", never asserted;
no match → "no known disruption reported". Voice re-provision after the tool-description update.

## M3 — Strike + disruption sources, all countries (SHIPPED 2026-07-05)

- **MIT scioperi** (IT) — the Transport Ministry's official strike registry RSS
  (scioperi.mit.gov.it — CGSSE itself proved unreachable from our infra, the MIT registry is the
  better structured source anyway): ADVANCE notice with exact dates, sector, region, unions.
  Filtered to port-relevant sectors (marittimo/portuale/merci/logistica/generale/multisettoriale).
  Live check on ship day: national freight-haulage strike Jul 10, Sicilia maritime Jul 17,
  NATIONAL MARITIME Jul 22 — real advance signal from day one.
- **Union-curated news** — per-country union names in the registry (RMT/Unite, FNV Havens/FNV,
  CCOO/UGT/Coordinadora Estibadores, Filt/Fit/Uilt/USB) queried through the locale-aware news
  fetch, strike-term matched. The parity workhorse; parity test enforces ≥1 union per country.
- **GDELT** — strictly best-effort (1-req/5s rate limit, flaky): non-JSON degrades to [].
- Events normalize to {id, country, kind scheduled|report, summary, confidence, startsAt?} —
  startsAt ONLY from the official calendar (headline date-guessing breeds false alarms).
- Relay: refreshDisruptions every 3h → merged cache → `/ais/disruptions?country=&port=` (private;
  Vercel proxy api/ais-disruptions.js behind requireApiKey) + strikeReasonForPort folded into the
  M2 port context. Marco tool `get_upcoming_disruptions` (+ grounding-eval case).
- Deferred from M3: port-authority operational notices (Rotterdam/Valencia/Genoa) — revisit if
  the news layer proves too thin.

## M4 — Proactive disruption notifications (SHIPPED 2026-07-05)

`evaluateDisruptionWatches` in assistant/watches.mjs, on the EXISTING ticker (same tick, same
platform-neutral send()): port_congestion watches AUTO-INCLUDE their port's scheduled-strike
alerts (owner decision) + new watch type `port_disruption` (disruptions only). One-shot semantics
(a strike is a fact, not a flapping signal): per-watch `notifiedEvents` dedupe (capped 50,
persisted) — one strike never pages twice. One /ais/disruptions?port= fetch per DISTINCT watched
port per tick (relay applies the 7-day lookahead + area matching). Marco offers a watch after
answering get_upcoming_disruptions. Delivery: whatever platform the watch was created on
(Slack/Teams work today; WhatsApp templates + voice outbound stay deferred).

**'all ports' wildcard (2026-07-16):** a `port_disruption` watch with target `all ports` covers
every geofenced port via ONE unfiltered /ais/disruptions fetch per tick, with event-level dedupe —
a national strike that touches 15 ports pages once, not 15 times. New ports are covered
automatically (coverage resolves relay-side at fetch time; no per-port watch bookkeeping). The
7-day push lookahead is applied in evaluateDisruptionWatches for this path (the relay only enforces
it on ?port=); a far-out strike fires once when it enters the window. The ticker also now fetches
/ais/ports and the 3,000-vessel payload only when a watch type actually needs them.

**Lead-time evidence (2026-07-16, migration 010):** events themselves are in-memory only (3-hourly
refresh), so `disruption_log` records each event id's FIRST sighting (`db.logDisruptionsFirstSeen`,
called from the relay's refresh). Alert lead time = `starts_at - first_seen_at`; also enables the
news-precedes-calendar comparison (a `strike_report`'s first sighting vs the matching
`strike_scheduled`'s). Append-only, ON CONFLICT DO NOTHING; a logging failure never touches the
data path or trips health.

## M5 — Water-level disruptions (V1 SHIPPED 2026-07-19 — `scripts/water-levels.cjs`)

V1 as-built: Kaub gauge state machine (low ≤150 cm surcharge mark / critical ≤78 cm GlW, +3-day
trend), Venice tide + forecast maxima vs the 110 cm MOSE activation mark, ACP advisory scrape
(draft adjustments + lock outages, current-year, ids from PDF filenames). All official sources,
confidence 0.9, pull-only (no country/startsAt — pushes filter kind strike_scheduled). First live
run caught the real episode: Kaub 80 cm rising, plus the live Neopanamax draft-cut advisories.
Deviations from scope: BfG/ELWIS Kaub FORECAST layer deferred — verified at build, no
machine-readable feed exists (HTML only); ACP effective DATES deferred — they live inside the
advisory PDFs (advisory id + title is the v1 signal). Kaub-vs-Moerdijk dwell correlation still
pending episode maturity.

Water level is a first-class chokepoint observable the port-level AIS CANNOT see: during the July
2026 Rhine episode (Kaub 45 cm vs the 77 cm GlW line, barges at ~20% load, Rotterdam–Karlsruhe
freight +40%) our own Rotterdam/Moerdijk entries + dwell stayed FLAT for 14 days — payloads halve
but hulls keep moving. The gauge is therefore a LEADING indicator of hinterland-driven port
congestion, not a derivable one. Two mechanisms, two event kinds:

- `waterway_low_water` — corridor economics degrade (Rhine → Rotterdam/Moerdijk/Amsterdam/
  Vlissingen hinterland; Danube rides along free).
- `water_closure` / `draft_restriction` — direct blockage or capacity cut (Venice MOSE closures →
  venezia + porto_marghera, both geofenced; Panama Gatun draft cuts — announced WEEKS ahead, e.g.
  the live El Niño series: 49.5 ft Jul 3 → 49.0 Jul 24 → 48.5 Aug 15, 2026 — a calendar signal,
  exactly like the MIT strike registry).

Sources — every ✅ verified with a live call on 2026-07-16:

- ✅ **PEGELONLINE** (DE official WSV; free, keyless): Rhine 36 gauges (KAUB read 45 cm, state
  "low") + 27 Danube gauges. THE number surcharges/load restrictions key off (cm at Kaub) — never
  substitute a model proxy (Open-Meteo flood discharge rejected: m³/s is not the commercial ref).
  Forecast layer: BfG/ELWIS Kaub forecast (verify feed shape at build).
- ✅ **Venice open data** (dati.venezia.it; free): live tide (Punta Salute 0.47 m read live);
  MOSE closure = the port-blocking event; tide FORECASTS published (lead time).
- ⚠️ **ACP / Panama** (pancanal.com): official Gatun dashboards exist but NO clean API — 1990s
  HTML + Tableau. V1 ingests the ADVISORIES (draft-restriction announcements, dated) via scrape;
  the calendar is the signal, the lake level is nice-to-have.
- ⚠️ **Rijkswaterstaat waterwebservices** (NL official): documented POST API, endpoint 301'd —
  chase current host at build. Non-blocking for V1 (Rhine side covered by PEGELONLINE at Lobith).
- ✅ **IOC sea-level network** (1,927 global tide gauges, Gibraltar verified): the generic
  "tide level at any covered port" layer. DEFERRED past V1.
- ✅ USGS (Mississippi, Baton Rouge 22.44 ft verified) + Hub'Eau (FR, Seine verified): parked
  until a customer needs those corridors.

V1 = Rhine (PEGELONLINE current + BfG forecast) + Venice tide/MOSE + Panama advisories, as a
relay fetcher on the existing 3h disruption cadence, threshold state machines per gauge
(normal/low/critical off the documented marks, dwell-debounced like congestion watches), events
into the merged disruption cache → port context, get_upcoming_disruptions, watches (the 'all
ports' wildcard carries them with zero new wiring — extend its kind filter beyond
strike_scheduled). Also log to disruption_log (010) for lead-time evidence from day one.
Own-data bonus: correlate Kaub history vs our Moerdijk/Rotterdam dwell series to MEASURE the
hinterland lag — a real exogenous feature for the congestion forecast once the episode matures.

## M6 — Chokepoint flow monitor (Hormuz/Suez) (SCOPED 2026-07-16)

Straits are NOT water-level problems (Hormuz ~90 m deep; Suez is a sea-level canal — no locks):
the observable is TRANSIT FLOW + security posture. Coverage verdict from live probes of our own
global aisstream subscription (2026-07-16): map holds 20,811 vessels worldwide — Singapore box 82,
Gibraltar 83, Gulf of Suez approach 27, but **Persian Gulf + Gulf of Oman incl. Jebel Ali: 0** and
**Bab el-Mandeb: 0**. aisstream is terrestrial; there are simply no receivers there. AIS-based
Hormuz flow counting is NOT buildable on our current feed — satellite AIS (paid) is the only fix;
see docs/AIS_PROVIDER_ALTERNATIVES.md before ever paying.

**Satellite deep-research verdict (2026-07-17, 10 findings, all adversarially verified 3-0):**
S-AIS consolidated into a sales-gated duopoly in 2025 (Kpler bought Spire Maritime + owns
MarineTraffic, which killed self-serve API credits Jan 2025; S&P Global bought ORBCOMM AIS,
closed Nov 2025) — no public Gulf coverage/pricing survives, and "~5s latency" marketing is a
blended figure (third-party tests: 10-60 min effective). NO verified <$1k/mo Hormuz transit path
exists: cheapest self-serve AIS API (Datalastic €199/mo) is terrestrial-only at that tier
(satellite add-on price unverified — one email resolves). Free tier that IS real: Copernicus Data
Space APIs (server-side Sentinel-1 GRD processing, 12TB/mo + 10k requests/mo free) → DIY weekly
SAR port-occupancy snapshots for Gulf ports; Global Fishing Watch's SAR-detection API proves the
technique but is non-commercial-licensed + offline (Jul 2026) — validation benchmark only, never a
production dependency. Step-change: tasked SAR (Capella-class, 3-6h delivery, price quote-only).
Windward/Ursa confirm the pattern: nobody owns satellites; buy AIS + broker SAR + differentiate on
fusion — which is the layer we already run. Consequences: M6 V1 (market-implied) is the cheapest
credible transit proxy, not a stopgap; a Sentinel-1 occupancy spike earns a roadmap slot;
paid S-AIS waits for a customer to fund it. Full cited report: claude.ai artifact
"Satellite Maritime Monitoring — Verified Source & Cost Report".

V1 without AIS — both sources verified/known:

- ✅ **Polymarket** (gamma-api.polymarket.com — ALREADY an integrated relay host): live Hormuz
  market cluster with real liquidity (verified 2026-07-16: "0–20 avg daily transits end of July"
  @ 73%, "week under 100 transits" @ 86%, "normal by Dec 31" @ 54%, ~$38k 24h volume). Market-
  implied transit bands → chokepoint state (normal/disrupted/severe), confidence = price.
  Events kind `chokepoint_disruption`, hedged wording (market-implied, not measured).
- **UKMTO advisories** (ukmto.org warnings): the official operational alert channel for the
  region — ships get these before newspapers. Feed shape (scrape/RSS) to verify at build.
- Suez partial: Gulf-of-Suez AIS box (27 vessels live) could give a rough northern-approach
  queue proxy later; Bab el-Mandeb stays blind without satellite AIS. Say so honestly in any
  customer-facing display.

## Open questions

1. ~~Confidence floor for proactive pushes~~ RESOLVED in M4: pushes are OFFICIAL-CALENDAR ONLY
   (kind strike_scheduled); news-matched reports stay pull-only — a hedged headline never pages.
2. Quiet hours / digest batching for multi-disruption days.
3. Whether GB weather alerts need the Met Office CAP feed instead of Meteoalarm (UK feed exists
   but had 0 active entries when checked — verify it populates during a real warning).
4. M5/M6 push policy: gauge/market STATE TRANSITIONS are the strike-calendar analog (official,
   quantitative) — do they page like scheduled strikes, or start pull-only for a shakedown week?
5. M6: does a market-implied signal meet the M4 bar ("a hedged headline must never page you")?
   Proposed: UKMTO advisories page; Polymarket state changes are context/pull until proven.
