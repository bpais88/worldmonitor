# Freight board (`ferry.html`) — visual audit & redesign proposal

**Scope: `ferry.html` only** — the European Freight Tracker. Not the main dashboard.

Audited 2026-08-01 against production (`worldmonitor-x5wwiqfbn`) **after** the basemap fix
(#128 + #129), so every observation below is of a map that actually renders. Companion to
[FRONTEND_CAPABILITY_INVENTORY.md](./FRONTEND_CAPABILITY_INVENTORY.md).

---

## Part 1 — What the audit found

### The headline

**The map shows one thing — where ships are — and the product's best data never reaches it.**

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

1. **Ports mode doesn't change the map.** As above. The single biggest gap.

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

6. **Chrome eats the screen before the map starts.** Title + two-line description + status +
   region tabs + mode tabs + search + operator chips consume ~295px of a 727px viewport — **~40%
   above the fold** before a single pixel of map.

7. **The playback control floats over the map**, bottom-centre, covering water in the Bay of Biscay.

8. **Status-line string bug:** renders `CACHED · warming up — vessel count still filling363` — the
   vessel count is concatenated with no separator. Also seen as `LIVE · as of 21:23 CEST1904`.

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

### P1 — Ports mode renders ports (the big one)

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

### P5 — Give the map the screen

Collapse the description into a `(i)` affordance, move region tabs and operator chips into a single
compact toolbar, and let the map take the space back. Target: map begins within ~120px, not 295px.

### P6 — Use the time dimension already built

`VoyageReplay` + `PlaybackControl` exist and work. Extend the same scrubber to replay **port
congestion over the last 24–48h** from `port_snapshots`, which is already stored and served. This is
the one feature no competitor has, and the UI for it is already on screen.

### Sequencing

| | Change | Effort | Payoff |
|---|---|---|---|
| 1 | P1 ports-on-map | M | **Highest** — puts the product's core signal on the map |
| 2 | P3 collision + clustering | M | Makes dense water readable |
| 3 | P5 reclaim screen space | S | Cheap, immediately felt |
| 4 | P2 zone legibility | S | Removes a dead control |
| 5 | P4 vessel encoding | M | Depth once the basics read well |
| 6 | P6 congestion replay | L | Differentiator, build last |

Plus two trivial fixes worth doing immediately: the `filling363` string concatenation, and moving
the playback control out of the map's centre.

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
