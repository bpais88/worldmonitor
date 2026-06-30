# Multi-country expansion: Italy → + UK, Spain, Netherlands

**Goal:** Marco covers **container/cargo congestion + vessel tracking** for UK, Spain, and the
Netherlands alongside Italy. **Comprehensive** major-port coverage. Feed: **Marinesia** (for
reliability). Decided 2026-06-30.

**In scope:** ports + live congestion + freight-vessel tracking + watches + Q&A for the major
commercial/container ports of all four countries.
**Out of scope (for now):** the Italy-specific **ferry-route layer** (34 scheduled island
routes) — UK/ES/NL are container-dominant, not RoPax-island hubs. Add later only if a customer
asks for passenger-ferry schedules.

## Why this is config + data, not a rewrite
- **Two services, same repo:** `worldmonitor-relay` (runs `scripts/ais-relay.cjs` + `marinesia.cjs`
  — owns the AIS feed, `/ais/ports` congestion, `/ais/vessels`) and `italy-freight-assistant` (Marco,
  queries the relay). The expansion is **mostly a relay change**; the assistant only needs copy.
- **Port-agnostic data model:** ports are a JSON dataset (`src/config/italy-ferries.data.json`,
  shared by relay + app) with `lat/lon/aisNames/commercial`. Congestion is computed **live** from
  AIS vessel counts within 8 km of each port — **no per-port config**. Add a port entry → congestion,
  tracking, watches, port-call detection all activate automatically.
- **Italy is a query-time bbox filter, not an ingestion wall** (`ITALY_BBOX [35,6,46.5,19.5]`).

## Prerequisite — Marinesia procurement (USER ACTION, parallel)
The reliable feed needs a **Marinesia API key + quota** sized for the new regions. Italy is 9 tiles
(3×3 grid); UK/ES/NL add **~25–30 more tiles** (more coastline). **Pricing isn't public — contact
Marinesia sales.** Then set `MARINESIA_API_KEY` on the **`worldmonitor-relay`** service. Until then,
PR-1 runs on the current **aisstream** feed (global; the vessels are already there) so we can build +
validate the data before the feed swap.

## Sequenced PRs (each additive — must not regress live Italy)

### PR-1 — Ports + bbox (relay + shared data) · *no Marinesia key needed*
- Add the major UK/ES/NL **container ports** to the dataset: `id, name, lat, lon, aisNames[],
  region, commercial:true` + their **UN/LOCODEs**. **Coords/LOCODEs verified against an
  authoritative source (UN/LOCODE + port authority), not from memory.**
- Add the regional **operators/carriers** (Stena, DFDS, P&O, Brittany Ferries + container lines
  Maersk, MSC, CMA CGM, Hapag-Lloyd…) with AIS-name keywords; extend `OPERATOR_IDS` in
  `assistant/tools/freight.mjs`.
- **Widen the bbox** Italy → W-Europe (`~[35,-10,56,20]`): `src/config/italy-ferries.ts`,
  `agent/lib/gather.mjs`, the relay vessel query default.
- Congestion + tracking auto-compute. **Works on aisstream immediately** — a live demo before Marinesia.
- Deploys to BOTH services (shared data file). Regression-test that Italy ports still report the same.

**Proposed port list (verify coords/LOCODEs in the PR):**
- **UK:** Felixstowe (GBFXT), Southampton (GBSOU), London Gateway (GBLGP), Liverpool (GBLIV),
  Immingham (GBIMM), Tilbury (GBTIL), Teesport (GBTEE), Hull (GBHUL)
- **Spain:** Valencia (ESVLC), Algeciras (ESALG), Barcelona (ESBCN), Bilbao (ESBIO),
  Las Palmas (ESLPA), Tarragona (ESTAR), Cartagena (ESCAR), Vigo (ESVGO)
- **Netherlands:** Rotterdam (NLRTM), Amsterdam (NLAMS), Vlissingen (NLVLI), Moerdijk (NLMOE),
  Eemshaven (NLEEM)

### PR-2 — Marinesia multi-region feed (relay) · *needs the key*
- Refactor `scripts/marinesia.cjs`: `ITALY_TILES` → `REGION_TILES = { it, gb, es, nl }`, each a
  `makeGrid(bbox)`; env to select active regions (`MARINESIA_REGIONS=it,gb,es,nl`).
- `scripts/ais-relay.cjs` polls all active regions round-robin (mind the 5 req/min rate + 2000/tile cap).
- Set `MARINESIA_API_KEY` (+ regions) on `worldmonitor-relay`; the reliability swap from aisstream.

### PR-3 — Assistant copy/prompts (assistant only)
- Generalize ~12 strings from "Italian ports" → "Italy, UK, Spain & the Netherlands": `DEFAULT_SYSTEM`
  (`assistant/agent.mjs`), `MARCO_PERSONA`, tool descriptions (`tools/freight.mjs`), onboarding
  (slack + teams), the Slack/Teams **manifests**, legal pages, landing copy.

### PR-4 (optional, later) — Frontend map + weather alerts
- Generalize the Italy-bbox ferry map to multi-region; extend Meteoalarm regions (it already covers
  ES/NL/UK — mostly config). Lower priority for the assistant's freight value.

## What does NOT change
Congestion thresholds (clear<4 / busy / congested≥8), watch evaluation, port-call detection, the
agent loop, the approval flow, the Slack/Teams adapters. All port-agnostic — they just see more ports.

## Risks / safety
- The relay serves the **live Italy pipeline** — every change is additive; regression-test Italy.
- **Stage on aisstream first** (PR-1) to validate the port data before the Marinesia swap (PR-2).
- Data curation (coords/aliases/LOCODEs) is the long pole — verify each port; wrong coords → wrong congestion.
- Naming: the dataset is `italy-ferries.data.json`; consider renaming to `freight-ports.data.json`
  in PR-1, or keep it (less churn) and just add ports.

## Effort
PR-1 ~2–3 days (mostly verified data curation) · PR-2 ~1–2 days (relay tiles) + the Marinesia
procurement (user, lead time unknown) · PR-3 ~half a day. First customer-demoable slice = PR-1 + PR-3.
