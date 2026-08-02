# Freight board (`ferry.html`) — visual audit & redesign proposal

**Scope: `ferry.html` only** — the European Freight Tracker. Not the main dashboard.

> **Status 2026-08-02 (end of day): P1, P2, P3 and P5 are SHIPPED. P4 is HALF shipped and its
> remaining half is NOT BUILDABLE as written. P6 is in progress.**
>
> | | state |
> |---|---|
> | P1 ports-on-map | shipped #132 |
> | P5 reclaim screen space | shipped #132 |
> | P3 labels + density | shipped — collision-aware labels via `text-allow-overlap: false` + `symbol-sort-key`; density solved by scaling marks with zoom rather than the proposed clustering |
> | P2 zone legibility | shipped #140 |
> | P4 vessel encoding | **half** — size by hull length shipped; category is not derivable, see below |
> | P6 congestion replay | in progress — history endpoint + scrubber landed |
>
> **P4's second half cannot be built from AIS.** The proposal asks to distinguish container / RoPax
> / tanker / general cargo. AIS ShipType does not carry that distinction: codes 70–79 subdivide
> cargo by HAZARD CLASS, not cargo type. Measured against the board's own query
> (`types=cargo,passenger&freight=1`), the displayed population is **98.7% cargo / 1.3% passenger**
> (2017 vs 27 of 2044), and **91.6% of vessels are ShipType 70 or 79 — both meaning "cargo,
> unspecified"**. A colour encoding on that paints one hue on 2017 marks and another on 27. Real
> type data needs a vessel registry (IMO → type), which is a data-sourcing project, not a map
> change. The one encodable signal found instead: **133 vessels (6.5%) broadcast hazardous-cargo
> classes A–D** and currently render identically to everything else.
>
> Part 1 below is preserved as the audit that motivated the work — several of its findings are now
> historical, and are marked inline.

Audited 2026-08-01 against production (`worldmonitor-x5wwiqfbn`) **after** the basemap fix
(#128 + #129), so every observation below is of a map that actually renders. Companion to
[FRONTEND_CAPABILITY_INVENTORY.md](./FRONTEND_CAPABILITY_INVENTORY.md).

---

## Part 1 — What the audit found

### The headline — FIXED (#132)

**The map showed one thing — where ships are — and the product's best data never reached it.**

Switching the mode tab from **Vessels** to **Ports** leaves the map *completely unchanged*. Only the
table below swaps. So per-port congestion — the signal Marco is instructed to lead with, backed by
~345k snapshots and per-port day-of-week x hour baselines — is **table-only**. The map is not
participating in the product's main question.

That table is genuinely good:

| Port | Status | At port | Waiting | Arrivals · 24h |
|---|---|---|---|---|
| Algeciras | **Congested** | 25 | **10 ⚠** | 13/16 ▁▃▅ `6<6h` |
| Rotterdam | Busy | 7 | 0 | 0/5 |
| Barcelona | Busy | 6 | 1 | 4/6 ▁▃ |
| Leixões | Busy | 4 | 3 | 0/1 ▁ |

None of it is on the map. A user looking at the map cannot see that Algeciras is congested with ten
ships waiting.

### Specific defects, in priority order

1. ~~**Ports mode doesn't change the map.**~~ **FIXED (#132).** Ports mode now draws the 43 ports:
   radius = `atPort`, fill = `congestionRel`, ring = the anchor queue, hollow = no coverage.

2. **"Port zones" produces nothing visible.** Toggling it on at the default European view renders
   no change — the geofence circles are 2.5–20 km, which at that zoom are sub-pixel. A control that
   visibly does nothing reads as broken.

3. **Label collision in exactly the places that matter.** In the Channel/Benelux cluster and off
   Gibraltar, vessel labels overlap each other and their own dots — `CHARLESTON EXPRESS`,
   `AQUATEAM II`, `EDMY`, `KATHY C` pile up. The densest water is the least readable, which is
   backwards.

4. **One mark for everything.** Every vessel is a small circle or a small arrow. Nothing encodes
   size, cargo type (container vs RoPax vs tanker), or importance. The legend describes *status*
   only — under way / at anchor / in port.

5. **The viewport is fit to a bounding box, not to the data.** `EUROPE_BBOX` spans to Turkey and
   Ukraine, so a third of the canvas is permanently empty land while the dense clusters are cramped
   into a corner.

6. ~~**Chrome eats the screen before the map starts.**~~ **FIXED (#132).** 270px → **134px**; the
   map went from ~420px to 616px, 73% of the viewport.

7. ~~**The playback control floats over the map.**~~ **FIXED (#132)** — and it was a bug, not a
   design choice. `VoyageReplay` sets `bar.hidden = true`, but `.voyage-replay { display: flex }` is
   an author rule and beats the UA's `[hidden] { display: none }`, so the attribute never had any
   effect. It is contextual and now behaves like it.

8. ~~**Status-line string bug**~~ **FIXED (#132).** `.panel-count` is a separate element that
   `main.css` spaces away from the badge; this standalone page never loads `main.css`.

### What is already good and must be kept

- Region filter (All / Italy / UK / Portugal / Spain / Netherlands) with counts
- Operator chips with live per-operator counts
- Search across vessel and operator
- Heading arrows for under-way vessels — a genuine encoding that works
- Click-to-fly, vessel popups, and **voyage replay with a playback control** — real time-travel UI
  that already exists
- Delay detection with `Delayed +2…` badges and ETA in the table
- The ports table's sparklines and `6<6h` arrival chips

---

## Part 2 — Proposal

Principle: **the map should answer whatever the mode is asking.** Today it always answers "where are
the ships". Three of the four highest-value changes are about making it answer the other questions,
using data the backend already serves.

### P1 — Ports mode renders ports (the big one) — SHIPPED #132

When mode is **Ports**, the map's primary marks become the 43 commercial ports:

- **Radius** ∝ `atPort` (vessels currently at the port)
- **Fill** = `congestionRel` — the size-independent signal, on a 3-step scale
  (clear / busy / congested), with a distinct "unknown" treatment for null, which is common and
  must not read as "clear"
- **Ring** = `waiting` (anchor queue) — a partial arc or outer ring, so Algeciras' 10 waiting is
  visible at a glance
- **Dim the vessel layer** to context weight rather than hiding it

Everything needed is already on `/ais/ports`: `congestion`, `congestionRel`, `atPort`, `atBerth`,
`atAnchor`, `inbound`, `coverageOk`. **No backend work.**

Uncovered ports (`coverageOk: false`) must render as explicitly *unknown* — hollow or hatched —
never as clear. That is the whole point of the coverage work in #125.

### P2 — Make zones legible, or drop the toggle

Either render geofences with a **minimum screen radius** (~6–8px) so they're visible when zoomed
out and become true-scale as you zoom in, or replace the toggle with a per-port halo that's always
on in Ports mode. A control that appears to do nothing is worse than no control.

### P3 — Fix label collision and low-zoom density

- Collision-aware label placement (deck.gl `CollisionFilterExtension`, or MapLibre symbol layers
  which do this natively)
- **Cluster vessels below ~zoom 6** with a count badge — the Benelux blob becomes "47" until it's
  worth expanding
- Labels on hover/selection at low zoom; always-on only when they fit

### P4 — Encode what a vessel *is*

Size the mark by vessel length (already in the registry / AIS static data) and distinguish category
(container / RoPax / tanker / general cargo) by shape or hue. Turns a field of identical dots into
a readable fleet.

### P5 — Give the map the screen — SHIPPED #132

Collapse the description into a `(i)` affordance, move region tabs and operator chips into a single
compact toolbar, and let the map take the space back. Target: map begins within ~120px, not 295px.

### P6 — Use the time dimension already built

`VoyageReplay` + `PlaybackControl` exist and work. Extend the same scrubber to replay **port
congestion over the last 24–48h** from `port_snapshots`, which is already stored and served. This is
the one feature no competitor has, and the UI for it is already on screen.

### Sequencing

| | Change | Effort | Payoff |
|---|---|---|---|
| ~~1~~ | ~~P1 ports-on-map~~ | — | **SHIPPED #132** |
| ~~3~~ | ~~P5 reclaim screen space~~ | — | **SHIPPED #132** — 270px → 134px |
| ~~1~~ | ~~P3 collision + clustering~~ | — | **SHIPPED** — collision-aware labels; zoom-scaled marks instead of clustering |
| ~~2~~ | ~~P4 vessel encoding~~ | — | **HALF SHIPPED** — size done; category not derivable from AIS (see status above) |
| ~~3~~ | ~~P2 zone legibility~~ | — | **SHIPPED #140** |
| **1** | **P6 congestion replay** | L | **Next.** The differentiator — data and scrubber now exist |

~~Plus two trivial fixes worth doing immediately~~ — both shipped in #132.

**Lesson recorded from building P1.** The port-label placement took four attempts, every one
corrected from a screenshot the owner pasted back, because this session's browser could not render
a map at all. Before touching map rendering again, build a non-WebGL preview (SVG over the real
feed) and check it first — that is what caught the radius domain clamping Rotterdam and Amsterdam to
the same size *before* it shipped.

### Explicitly not proposed

- **No 3D, terrain, or globe.** Freight monitoring is a 2D plan-view task; tilt would cost
  legibility and buy nothing.
- **No basemap swap.** CARTO dark-matter is keyless, fast and appropriately recessive now that it
  renders.
- **No new backend.** Every proposal above is served by existing endpoints.

---

## Verification notes

Findings are from screenshots of production on clean loads with no prior interaction. Three
measurement techniques were tried and **discarded as invalid** — recorded so they aren't repeated:

- `performance.getEntriesByType('resource')` cannot see vector tiles (MapLibre fetches them in a
  **Web Worker**; worker requests never appear in main-thread resource timing)
- `readPixels` on a live canvas returns black unless `preserveDrawingBuffer` was set at context
  creation
- Screenshots taken immediately after a programmatic window resize catch a transient
