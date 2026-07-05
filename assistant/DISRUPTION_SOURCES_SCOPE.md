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

## M3 — Strike + disruption sources, all countries (full curated set)

- **CGSSE** (IT) — the official national strike calendar: structured, ANNOUNCED IN ADVANCE
  (future `startsAt` — fuel for M4 and later the forecast).
- **GDELT** — one fetcher, all countries, STRIKE/PORT/MARITIME themes.
- **Curated union feeds** — RMT/Unite (GB), FNV Havens (NL), CCOO/UGT (ES); scraping surface,
  keep each behind the registry so parity is enforced.
- Optional: port-authority operational notices (Rotterdam/Valencia/Genoa) if stable feeds exist.
Each source = one more registry-driven explainer; the parity test grows a field per source class.

## M4 — Proactive disruption notifications

New watch type `port_disruption` on the EXISTING watch ticker (assistant/server.mjs — evaluate →
state-change → platform-neutral send()). Port-congestion watches auto-include their port's
disruption alerts; Marco offers watches in conversation. Upstash dedupe per disruption id (one
strike ≠ daily spam). Pull tool `get_upcoming_disruptions` (next 7 days, per port/country).
Delivery: Slack/Teams/Telegram now; WhatsApp needs pre-approved templates outside the 24h session
window (defer); voice = outbound calls (park).

## Open questions (revisit at M3/M4)

1. Confidence floor for proactive pushes (only official/structured sources? news ≥0.45?).
2. Quiet hours / digest batching for multi-disruption days.
3. Whether GB weather alerts need the Met Office CAP feed instead of Meteoalarm (UK feed exists
   but had 0 active entries when checked — verify it populates during a real warning).
