# Frontend & Backend Capability Inventory

**Purpose.** A complete record of what World Monitor can already do, before any redesign work.
Two audiences: engineers (so nothing gets dropped in a refactor) and product (so the capability
surface can be communicated as user value). Written 2026-08-01 against `main` @ `b89b67b`.

**Status: step 1 of 2, and now partly historical.** This captured the *current state* before any
redesign. The proposal that followed lives in
[FREIGHT_MAP_AUDIT_AND_PROPOSAL.md](./FREIGHT_MAP_AUDIT_AND_PROPOSAL.md); its P1 and P5 shipped in
PR #132. Findings below that have since changed are marked inline.

> Sourced by reading the codebase, not the docs. Anything not directly verified is marked
> *(unverified)*.

---

## 0. Read this first — two findings that reframe everything below

### 0.1 This repo is a fork of a shared ancestor — but we are our own product

**Decided:** we are not tracking upstream. This is our project; the fork relationship is historical
only. Recorded here purely so nobody re-derives it and mistakes upstream's site for ours.

Two practical consequences worth remembering:

- **`worldmonitor.app` is upstream's deployment, not ours.** Don't audit it, don't screenshot it as
  "our app". Ours is the `bruno-pais-projects/worldmonitor` Vercel project.
- **Do not add an `upstream` git remote.** Doing so silently retargets `gh pr create` at
  `koala73/worldmonitor`, which fails with a confusing "No commits between main and …". If a PR
  ever fails that way, check `git remote -v` first, or pass `--repo bpais88/worldmonitor`.

The original comparison, for the record:

`bpais88/worldmonitor` is a fork of **`koala73/worldmonitor`**.

| | Ours | Upstream |
|---|---|---|
| Version | **2.5.24** | **2.10.0** |
| Commits the other side has that we don't | — | **3,629** |
| Our own commits | **175** | — |

**`worldmonitor.app` is upstream's deployment, not ours.** Ours is a separate Vercel project
(`bruno-pais-projects/worldmonitor`). Confirmed: `worldmonitor.app/ferry.html` returns the generic
SPA shell with zero freight content — our freight board is not live there.

Upstream's current UI already has things a redesign would otherwise propose from scratch: a **2D/3D
toggle**, mission/workspace presets (Crisis Desk, Supply-Chain Risk, Energy Security, …), a
searchable layers panel, and OpenFreeMap basemap tiles. Upstream's dashboard has **no
`.maplibregl-map` element at all** — they have moved to a different renderer than the one this
fork uses.

**Resolved: (b) — stay diverged and build our own.** Upstream's feature set is therefore not a
constraint, a benchmark, or a source to cherry-pick from. Everything in this document describes our
codebase and our deployment only.

### 0.2 The freight map rendered nothing — FIXED (#128 + #129)

Measured on our own production deployment (`worldmonitor-g2g1u74g1`), after a full settle:

```
vectorTiles requested : 0          <-- never loads a single map tile
cartocdn requests     : 4          <-- style.json, tiles.json, sprite@2x.json, sprite@2x.png
.maplibregl-map       : 1395x353   <-- correctly sized
console errors        : none
```

The style, TileJSON and sprites all load; **no `.pbf` vector tile is ever fetched.** The map area
is black apart from what deck.gl draws. On `ferry.html` it was worse — a completely black map under
a fully populated UI (1,937 vessels, live operator counts, working filters).

**Root cause: a zero-sized viewport at construction, never re-measured.** `ItalyFerryPanel` builds
its scaffold and constructs the map in one synchronous pass, and hides the host with `display:none`
whenever the mode isn't "vessels". Either path lets MapLibre latch a 0x0 viewport — and with a zero
viewport *no tile is ever in view*, so none is requested, while the style/TileJSON/sprites still
load because those are main-thread fetches independent of the viewport. No error, no failed request,
and the host measures correctly by the time anyone inspects it. It reads as "the basemap is broken"
rather than "the map has no size".

Ruled out first, each by direct measurement rather than inference:

| Suspect | Verdict |
|---|---|
| CSP blocking tiles | **No** — from the page, a real tile fetches `200` (691 KB), a glyph `200`, a blob worker spawns |
| MapLibre / CARTO | **No** — a bare map with the same style URL on the same page renders perfectly |
| `ItalyFerryMap` itself | **No** — constructed against a pre-sized container it renders perfectly |
| `.maplibregl-canvas-container` height 0 | **Red herring.** An earlier draft of this document called this out as the smoking gun. It is not — the *working* control map shows height 0 too. That is normal MapLibre DOM. |

Decisive confirmation: **resizing the browser window on production made the whole map appear at
once** — basemap and ~1,900 vessels — because that finally fired MapLibre's own observer.

**Fixed by two changes, and the verification of them was messier than it should have been:**

- **#128** added the `ResizeObserver` that `DeckGLMap` has always had, guarded on a non-zero box.
- **#129** added a `resize()` in `onLoad()`, because the observer's single `observe()` callback
  lands before the style has loaded when the host is already sized.

Together these fixed it: clean loads now render the full basemap with ~1,900 vessels, repeatably.

**A process note worth keeping.** In between I twice reported this as unfixed when it wasn't. Both
false readings came from measuring badly, not from the code:

- Screenshots taken immediately after a programmatic window resize caught a transient and showed
  black.
- `performance.getEntriesByType('resource')` was used to count vector tiles and always returned
  zero. **MapLibre fetches vector tiles in a Web Worker, and worker requests never appear in
  main-thread resource timing.** Every "0 tiles" figure gathered that way was meaningless.
- `readPixels` on the live canvas returned all-black even while the map was visibly rendered,
  because `preserveDrawingBuffer` must be set when the context is *created*.

The reliable check is a screenshot on a clean load with no interaction beforehand.

A reviewer flagged #129 as a same-size no-op. That mechanism does **not** apply here — maplibre-gl
**5.16.0**'s `resize()` has exactly one early return, for a lost WebGL context
(`maplibre-gl-dev.js:69016`), then unconditionally runs `_resizeInternal` and fires
`movestart`/`move`/`moveend`, which schedules an update.

Also ruled out along the way: a bare map constructed from the **deployed production maplibre chunk**
renders perfectly, so the production bundle and its tile worker are fine.

**Still open:** the main dashboard map *has* the observer yet showed a partial render in this audit.
It needs its own check.

*(Unrelated, spotted on ferry.html: the header renders `LIVE · as of 10:56 CEST1385` — the vessel
count is being concatenated into the timestamp string.)*

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

**Correction after the visual audit:** an earlier draft of this document claimed there was no on-map
legend or layer control. That was wrong — reading the source alone missed it. The running app has
both:

- a **LAYERS panel** docked top-left, with a "Search layers…" box, per-layer checkboxes and an
  `(i)` info affordance on each row
- a **LEGEND strip** along the bottom of the map (`High Alert · Elevated · Monitoring · Conflict
  Zone · Base · Nuclear`)
- a time-range selector above it (`1h / 6h / 24h / 48h / 7d / All`)

The command palette (`src/config/commands.ts`, `search-manager.ts`) is an additional route, not the
only one. The real discoverability question is therefore narrower than "there is no control": it is
whether a flat, searchable checkbox list is the right instrument for ~47 toggles, and whether the
legend can express 68 layers when it currently names 6 categories.

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

0. ~~The freight map draws no basemap~~ — **fixed** (§0.2, #128 + #129).
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

**Visual audit: done** (step 1b, same day) against our own production deployment and, as a control,
upstream's. It produced the two findings in §0 and corrected the layer-control claim in §2. Measured
directly in-page: element geometry, resource timings, vector-tile counts, console errors.

**Still not verified:** layer density *with a working basemap* — colour collisions, overlap and
perceived hierarchy at various zooms can only be judged once tiles render (§0.2). That re-assessment
is the remaining input to a design proposal, and is deliberately blocked on the basemap fix rather
than guessed at.

## 9. Recommended sequence

1. ~~Decide the upstream question~~ — **done**: we stay diverged (§0.1).
2. ~~Fix the freight basemap~~ — **done** (§0.2, #128 + #129).
3. **Re-check the main dashboard map**, which has a ResizeObserver yet still rendered partially.
4. **Re-run the visual audit** on a working map, at several zooms and across the four variants.
5. *Then* write the redesign proposal, grounded in what it actually looks like.
