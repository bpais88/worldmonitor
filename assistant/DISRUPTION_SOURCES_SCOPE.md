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

## Open questions

1. ~~Confidence floor for proactive pushes~~ RESOLVED in M4: pushes are OFFICIAL-CALENDAR ONLY
   (kind strike_scheduled); news-matched reports stay pull-only — a hedged headline never pages.
2. Quiet hours / digest batching for multi-disruption days.
3. Whether GB weather alerts need the Met Office CAP feed instead of Meteoalarm (UK feed exists
   but had 0 active entries when checked — verify it populates during a real warning).
