# AIS Data Provider Alternatives

Researched 2026-06-21, after aisstream.io began delivering **zero frames** despite
healthy connect+subscribe — a known, recurring platform-side outage on aisstream
(GitHub issues [#15](https://github.com/aisstream/aisstream/issues/15) Mar 2026,
[#203](https://github.com/aisstream/issues/issues) Jun 2026; no maintainer fix).

## The core constraint

aisstream gave us a **free, unlimited, push WebSocket stream**. That model is rare.
Every mainstream alternative is **REST + credit-metered**: you pay per call (often
per vessel returned), so *continuous* tracking of a region costs money indefinitely.
Free tiers exist but are sized for occasional lookups, not 24/7 monitoring.

Reference math: polling one "vessels-in-area" call per minute, 24/7 ≈ **43,200
calls/month**. Every free tier below is far under that.

## Options compared

| Provider | Free tier | Cheapest paid | Model | Coverage | Fit |
|---|---|---|---|---|---|
| **aisstream.io** (current) | Unlimited stream | — | WebSocket push | Global, contributor-based | ✅ ideal *when up* — but unreliable |
| **AISHub** | Free **if you run a receiver** (RTL-SDR, ≥10 vessels, 90% uptime) | — | HTTP poll, max 1/min | Global, 1,200+ stations; Med decent | ✅ best *free* path if you can run hardware |
| **Datalastic** | 14-day trial only | **€99/mo** | REST credits (1 cr = 1 vessel position) | Global | 💰 cheapest "proper" self-serve real-time |
| **VesselAPI** | 150 calls/mo | $14.99 → $59.99 (1.5k → 15k calls/mo) | REST; WebSocket only for *notifications* | Global terrestrial, coastal/port strong | ⚠️ viable only at low poll rate |
| **Data Docked** | 20 trial credits | ~€80/mo | REST credits | Global + satellite | 💰 similar to Datalastic |
| **VesselFinder** | none | €330 min | REST credits (1 cr/terrestrial pos) | Global | 💰 pricier |
| **MarineTraffic / Kpler** | none | Enterprise "contact sales" | — | Global | ❌ consolidated, enterprise-only now |

(Kpler now owns MarineTraffic, FleetMon, Spire; S&P owns ORBCOMM — the market
consolidated, killing most transparent per-call pricing.)

## What a switch actually costs us (engineering)

Our relay's ingest is the **only** part that's provider-specific. Everything
downstream is provider-agnostic and stays as-is:
- vessel-state map, classification (`classifyFreight`), the persistent registry,
  ETA (`ferry-eta.cjs`), all explainers, the monitor agent.

To swap providers we replace `connectUpstream()` (a persistent WebSocket) with a
**poll loop** that hits an area endpoint every N seconds and feeds the same
internal vessel shape. Contained change (~half a day), and worth doing behind a
small provider interface so we can keep aisstream *and* a fallback poll source.

## Recommendation

- **Short term:** keep waiting on aisstream (free, unlimited — just down). The
  30-min health loop catches recovery automatically.
- **If we need reliability with zero budget:** AISHub — but it requires running a
  physical AIS receiver (~€30–40 RTL-SDR + antenna) near an Italian port. One-time
  setup, free forever, good Med coverage. Only viable if someone can host hardware.
- **If there's a small budget:** Datalastic €99/mo (or VesselAPI $59.99/mo if the
  area-query credit math works out at a 5-min poll cadence) is the path to a
  dependable feed without hardware.

Decision pending. Until then we run on aisstream and wait.
