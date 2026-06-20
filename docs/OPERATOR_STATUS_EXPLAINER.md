# Operator-Status Explainer (design draft — NOT yet implemented)

Status: **Draft / not implemented.** This documents the intended design so we can
build it deliberately later. Nothing here is wired into the relay or UI yet.

## Goal

Add an authoritative "why is this ferry delayed?" source backed by the **ferry
operators' own service notices** (Caremar, GNV, SNAV, Tirrenia, Moby, Liberty
Lines, Siremar, Toremar, Grimaldi, Caronte, Alilauro, …). When an operator
announces a strike (*sciopero*), weather suspension (*maltempo*), or a specific
cancellation, that is the single highest-confidence explanation we can attach to
a flagged crossing — higher than general news, weather, or congestion inference.

This becomes the 6th source in the existing pluggable explainer registry
(`scripts/delay-explainers.cjs`), alongside weather (🌊), port congestion (⚓),
cross-vessel correlation (🛳), and news (📰).

## Why it's not a clean drop-in (the feasibility reality)

Most Italian operator "avvisi" pages are **JavaScript-rendered SPAs**. The relay
is a Node process with no headless browser, so a static HTTP fetch of those URLs
returns an empty shell — not the notice text. Consequences:

- Per-site scrapers are **brittle** (each site differs, markup changes, some
  block bots) and become ongoing maintenance.
- Coverage will be **partial** — only operators exposing a fetchable source
  (RSS, JSON, or static HTML) can be read authoritatively.
- The existing **news explainer remains the broad safety net** for operators we
  can't read directly (it already matches operator-named disruptions, at low,
  hedged confidence).

So the design favors **robustness + extensibility** over chasing every operator.

## Chosen approach: source registry + news fallback

A curated **per-operator source registry**. For each flagged ferry's operator:

1. **If a real source is registered** (RSS / JSON / static-HTML notices URL) →
   fetch it, scan recent items for disruption terms near the route, emit a
   high-confidence `operator` reason (`service_notice` / `strike`).
2. **Else** → fall back to an **operator-notice-focused Google News query**
   (keyless, robust, reuses `explainer-news.cjs` fetch) scoped to the operator +
   notice vocabulary. Emits a moderate-confidence `operator` reason.

This ships value immediately (fallback works for everyone) and grows more
authoritative as real per-operator feeds are verified and added — no code change,
just a registry entry.

## Architecture

New module `scripts/explainer-operator-status.cjs`:

```
// Pure (unit-tested):
matchOperatorNotice(items, ctx, now) -> Reason | null
  items: [{ title, link, pubMs|pubDate, summary? }]   // from feed OR news
  ctx:   { operatorName, destName, portName }
  rule:  recent (≤48h) AND mentions operator AND a notice/strike term
  out:   { source: 'operator', kind: 'strike' | 'service_notice',
           summary, url, confidence }

// Glue (thin):
fetchOperatorSource(source)            // type: 'rss' | 'json' | 'html'
makeOperatorStatusExplainer(registry)  // -> { id: 'operator', explain(ctx) }
```

Registry shape (curated; seed in `src/config/italy-ferries.data.json` next to
operators, so the TS app and cjs relay share one source of truth):

```jsonc
"operatorStatus": {
  "caremar":      { "domain": "caremar.it",        "feed": null },
  "gnv":          { "domain": "gnv.it",            "feed": null },
  "liberty_lines":{ "domain": "libertylines.it",   "feed": null }
  // feed: a verified RSS/JSON/HTML notices URL when one is found; null -> news fallback
}
```

Wiring (relay `ais-relay.cjs`): register the explainer in `DELAY_EXPLAINERS`
with the registry; it runs only for already-flagged vessels (same cached,
bounded enrichment loop as the others). No new key, no new infra.

UI: reuse the existing why-line. Add an icon for `source: 'operator'`
(`ferry-format.ts` `REASON_ICON`), e.g. 🏢 or 🚨.

## Confidence / ranking

- Real operator feed match → **0.8** (authoritative; near weather).
- News-fallback operator match → **0.55** (above general news 0.35–0.45, below
  weather/port).
- Aggregator already ranks by confidence and dedupes by `source:kind`, so an
  operator notice outranks the general news reason when both fire.

## Honest limitations

- Coverage starts at the **news-fallback level for all operators**; authoritative
  coverage grows one verified feed at a time.
- JS-only operators may never expose a static feed — they stay on the fallback.
- Italian/English notice vocabulary must be maintained (sciopero, soppress*,
  sospes*, maltempo, cancellat*, strike, cancelled, suspended).

## Build plan (when we pick it up)

1. TDD `matchOperatorNotice` (recent + operator + notice term; reject stale /
   off-operator / no-keyword).
2. `fetchOperatorSource` supporting `rss` (reuse `parseRssItems`), `json`,
   `html` (strip tags); + news fallback via `explainer-news.fetchNews`.
3. Add `operatorStatus` to the shared JSON; relay registry wiring.
4. UI icon + a geojson `whyText` test for the operator reason.
5. Verify keyless fallback live; document any verified per-operator feeds added.

## Open questions

- Which operators (if any) expose a real RSS/JSON/static notices source? (Needs
  per-operator verification.)
- Is the news-fallback meaningfully better than the existing news explainer, or
  should the news explainer simply be tightened instead? (Decide at build time.)
- Should operator notices also surface when a ferry is **on time** (e.g. "strike
  tomorrow") as a proactive alert, or only attach to flagged delays?
