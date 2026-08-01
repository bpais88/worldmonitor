# Frontend & Backend Capability Inventory

**Purpose.** A complete record of what World Monitor can already do, before any redesign work.
Two audiences: engineers (so nothing gets dropped in a refactor) and product (so the capability
surface can be communicated as user value). Written 2026-08-01 against `main` @ `b89b67b`.

**Status: step 1 of 2.** This is the *current state* only. The map redesign proposal is separate,
and deliberately not started until this inventory is agreed — the explicit goal is a more visual
map **while keeping and documenting every existing feature**.

> Sourced by reading the codebase, not the docs. Anything not directly verified is marked
> *(unverified)*.

---

## 1. The headline finding

The product is **data-rich and display-poor**. There is an enormous amount of live intelligence
behind the map, and the map renders almost all of it as coloured dots stacked on a flat basemap.

| Measure | Value |
|---|---|
| deck.gl layers defined | **68** |
| …of which `ScatterplotLayer` (dots) | **52 (76%)** |
| Other geometry types | 6 × Text, 3 × Icon, 2 × Path, 2 × GeoJson, 2 × Arc, 1 × Polygon, 1 × Heatmap |
| User-facing layer toggles (`MapLayers`) | **47 booleans** |
| Map viewport height | **50vh** — half the screen, above a panel grid |
| Basemap | CARTO `dark-matter` / `voyager` vector tiles, flat 2D |
| Terrain / globe / 3D extrusion / hillshade | **none** |

So the "limited" feeling is structural, not cosmetic. Three compounding causes:

1. **One visual grammar for 68 different things.** A cyber threat, a nuclear plant, a stock
   exchange, a protest cluster and a species recovery site are all a circle. Colour and radius are
   the only encodings doing work, so the map cannot express *kind*, *magnitude* and *urgency*
   at once, and dense regions collapse into overlapping blobs.
2. **The map is a strip, not a stage.** At 50vh with a dense panel grid below, it reads as one
   widget among ~27 rather than the centrepiece.
3. **The richest data is not on the map.** Freight congestion, port baselines, voyage histories,
   vessel profiles and disruption context are all served by the backend and surfaced only as
   text in panels or through the assistant.

---

## 2. Map architecture

### Two renderers

| | Desktop | Mobile |
|---|---|---|
| Component | `src/components/DeckGLMap.ts` (4,598 lines) | `src/components/Map.ts` (3,674 lines) |
| Stack | MapLibre GL + deck.gl overlay | d3 `geoProjection` + SVG |
| Selected by | `MapContainer.ts` via `isMobileDevice()` | same |

`MapContainer.ts` (659 lines) is the unified façade both sit behind. **Any redesign has to account
for two independent implementations** — the d3/SVG path is a full parallel renderer, not a
degraded mode, and it carries its own cable/pipeline/conflict/AIS-density drawing code.

### Basemap

CARTO `dark-matter-gl-style` (dark) and `voyager-gl-style` (light), attribution CARTO ©
OpenStreetMap. No MapTiler/Mapbox key required. WebGL context-loss handling and render-pause are
already implemented (`renderPaused`, `webglLost`).

### Layer inventory (68)

Grouped by domain, as defined in `DeckGLMap.ts`:

- **Conflict & security** — `hotspots` (+pulse), `ucdp-events`, `iran-events`, `bases` (+cluster,
  +text), `military-flights` (+clusters), `military-vessels` (+clusters), `nuclear`, `irradiators`,
  `gps-jamming`, `apt-groups`, `cyber-threats`, `protest-clusters` (+badge, +pulse)
- **Maritime & logistics** — `ais-density`, `ais-disruptions`, `ports`, `waterways`,
  `trade-routes`, `trade-chokepoints`, `repair-ships`, `cable-advisories`
- **Infrastructure & energy** — `datacenters`, `datacenter-clusters` (+badge), `cloud-regions`,
  `outages`, `minerals`, `renewable-installations`, `spaceports`
- **Economic & finance** — `stock-exchanges`, `financial-centers`, `central-banks`,
  `commodity-hubs`, `economic-centers`, `gulf-investments`
- **Tech** — `startup-hubs`, `accelerators`, `tech-hq-clusters` (+badge, +label),
  `tech-event-clusters` (+badge)
- **Climate & natural** — `earthquakes`, `fires`, `natural-events`, `climate-heatmap`, `weather`,
  `flight-delays`
- **Humanitarian & positive** — `displacement-arcs`, `positive-events` (+pulse), `kindness`
  (+pulse), `happiness-choropleth`, `species-recovery`
- **News & context** — `news-locations`, `news-pulse`
- **Base/overlay** — `country-interactive`, `country-hover-fill`, `country-highlight-fill`,
  `country-highlight-border`, `day-night`

### Layer control

`MapLayers` (47 booleans, `src/types`) persisted to `localStorage` under `worldmonitor-layers`.
Toggling flows through `event-handlers.ts:671`, and `data-loader.ts` uses the same flags to decide
which fetches to run — **layers are lazily loaded, so toggling is a data-cost decision, not just a
visual one.** This is a real asset for a redesign: turning a layer on already implies fetching it.

There is **no dedicated legend or layer-control surface on the map itself** — discovery happens via
settings and the command palette (`src/config/commands.ts`, `search-manager.ts`). *For 68 layers,
that is almost certainly the single biggest discoverability gap.*

---

## 3. Variants

Four products from one codebase (`src/config/variants/`), each selecting its own panels and
default layers:

| Variant | Config | Focus |
|---|---|---|
| `full` | 161 lines, 27 panels | Geopolitics / world monitor |
| `tech` | 322 lines | Startup hubs, cloud regions, accelerators, tech HQs/events |
| `finance` | 281 lines | Exchanges, financial centres, central banks, commodities |
| `happy` | 131 lines | Positive events, kindness, happiness, species recovery, renewables |

`base.ts` holds shared refresh intervals, storage keys and the `VariantConfig` contract. Each
variant declares both `mapLayers` and a separate `mobileMapLayers` — mobile already gets a
curated, reduced layer set.

`full` panels: map, intel, cii, cascade, politics, us, europe, middleeast, africa, latam, asia,
energy, gov, thinktanks, polymarket, commodities, markets, economic, finance, tech, crypto,
heatmap, ai, layoffs, stablecoins, monitors.

---

## 4. Frontend components

**74 components** in `src/components/`. Beyond the map and panels, the notable interactive pieces:

- `VoyageReplay.ts` + `PlaybackControl.ts` — **time-based replay already exists.** A redesign
  should build on this rather than reinvent it.
- `CountryDeepDivePanel.ts`, `CountryBriefPanel.ts`, `CountryIntelModal.ts`, `CountryTimeline.ts`
  — a full country drill-down surface
- `MapPopup.ts` (2,675 lines) — the on-map detail renderer; large, and effectively the map's
  entire information-display layer
- `StoryModal.ts`, `SignalModal.ts`, `SearchModal.ts`, `UnifiedSettings.ts`
- `ItalyFerryMap.ts` / `ItalyFerryPanel.ts` — the freight board (panel id still `italy-ferries`,
  title "European Freight")
- `VirtualList.ts` — virtualised lists for dense panels

---

## 5. Backend surface

### Vercel API (`api/`, 52 endpoints)

Domain RPC endpoints (`[rpc].ts` pattern): aviation, climate, conflict, cyber, displacement,
economic, giving, infrastructure, intelligence, maritime, market, military, news, positive-events,
prediction, research, supply-chain, trade, unrest *(list continues past the 40 sampled)*.

Direct endpoints include: `ais-ports`, `ais-vessels`, `ais-vessel-profile`, `ais-port-profile`,
`ais-trip`, `ais-geofences`, `ais-disruptions`, `ais-snapshot`, `opensky`, `oref-alerts`,
`polymarket`, `gpsjam`, `eia`, `geo`, `bootstrap`, `og-story`.

### AIS relay (Railway, `scripts/ais-relay.cjs`, 19 endpoints)

`/ais/ports` · `/ais/vessels` · `/ais/vessel-profile` · `/ais/port-profile` · `/ais/port-history` ·
`/ais/trip` · `/ais/voyages/daily` · `/ais/geofences` · `/ais/disruptions` · `/health` ·
`/metrics` · `/notam` · `/oref/alerts` · `/oref/history` · `/telegram` · `/yahoo-chart` ·
`/youtube-live` · `/opensky-diag` · `/opensky-reset`

Backed by Neon Postgres: `ports`, `port_snapshots`, `port_events`, `port_baselines`, `forecasts`,
`vessels`, `trips`, `trip_points`, `disruption_log`.

**This is the most under-displayed asset in the product.** Live at the time of writing: ~345k port
snapshots, ~364k port events, ~130k trips, per-port day-of-week × hour congestion baselines, and
geofence zones for 43 commercial ports across 5 countries. Almost none of it has a map
representation — no congestion choropleth, no berth occupancy over time, no voyage tracks on the
main map, no geofence zones outside the separate ferry view.

### Services layer

**127 modules** across 20+ domains in `src/services/`, including a client-side ML/analysis tier:
`ml-worker.ts`, `analysis-worker.ts`, `parallel-analysis.ts`, `clustering.ts`, `correlation.ts`,
`entity-extraction.ts`, `threat-classifier.ts`, `sentiment-gate.ts`, `temporal-baseline.ts`,
`geo-convergence.ts`, `focal-point-detector.ts`, `infrastructure-cascade.ts`.

*Derived, analytical signals like convergence, cascade and focal points are exactly the kind of
thing a map can show well and a list cannot — and none of them currently have a map encoding.*

### Assistant (Marco)

Multi-channel agent (`assistant/`) on Slack, Teams, voice, WhatsApp and Telegram, with tool modules
`freight`, `weather`, `profiles`, `watches`, `actions`. Shares the port registry and `ferry-eta.cjs`
with the relay, so **the assistant and the map already read from one source of truth.**

---

## 6. What the map is *not* currently doing

Stated plainly, as the input to the proposal:

1. **No visual hierarchy.** 76% of layers are dots; importance can only be shown via colour/radius.
2. **No temporal dimension on the main map**, despite `VoyageReplay` + `PlaybackControl` existing
   and the backend holding months of time-series.
3. **No area/shape encoding** beyond one heatmap, one polygon layer and a happiness choropleth —
   no congestion choropleth, no risk surfaces, no zones, no density fields.
4. **No 3D** — no extrusion for magnitude, no terrain, no globe.
5. **No on-map legend or layer switcher** for 47 toggles.
6. **The freight/analytics tier is a separate page**, not part of the main map.
7. **Half the viewport**, competing with 27 panels.

---

## 7. Constraints any redesign must respect

- **Two renderers** — deck.gl and d3/SVG both need a story; mobile is not a subset.
- **Four variants** — every layer decision multiplies across full/tech/finance/happy.
- **Lazy loading is tied to layer toggles** — visual changes have data-cost consequences.
- **Desktop app (Tauri)** ships the same frontend; see `docs/DESKTOP_CONFIGURATION.md`.
- **Variant-specific theming** already exists (`happy-theme.css`, light/dark per variant).
- **WebGL context loss** is handled today and must stay handled.
- **Performance** — 68 layers with lazy loading; adding heavier geometry types needs a budget.

---

## 8. Verification status

Verified by reading source: layer counts and types, `MapLayers` surface, renderer split, basemap
styles, variant configs, endpoint lists, component and service counts, DB schema, 50vh map height.

**Not yet done: a visual audit of the running app.** Layer *density in practice*, real-world
overlap, colour collisions and actual perceived hierarchy need the live site, and should be
step 1b before any proposal is written.
