# AIS Vessel Classification — Research Notes & Sources

Why this exists: before hardcoding how we tell **freight** vessels (cargo /
RoRo / RoPax) from **tourist/passenger** vessels (cruise ships, tourist ferries,
hydrofoils) from a live AIS feed, we researched how practitioners actually do
it. These notes back the `isFreightVessel` rule in `scripts/ferry-eta.cjs` /
`src/services/logistics/ferry.ts`.

Date: 2026-06-21. Method: a deep-research pass (5 angles, 15 sources, 66 claims
extracted → 25 adversarially verified, 24 confirmed / 1 refuted). Verdict: our
approach is **validated**; the notes below also define the concrete hardening
path.

## Bottom line

> Our plan — **freight = cargo (70-79) + passenger (60-69) operated by a freight
> RoPax line, excluding cruise/tourist** — is "directionally well-founded and
> aligns with practitioner practice." Harden it later by joining **MMSI→IMO** and
> **IMO→Equasis ship-type** as a verifiable per-hull cross-check, rather than
> relying on the broadcast type or a static operator list alone.

## Verified findings

1. **The AIS ShipType code resolves only broad classes — by design it cannot
   solve our hard cases.** The second digit encodes IMO *hazardous-cargo*
   category (A-D), not vessel function. So cargo (70-79) lumps container / RoRo /
   bulk / general together, and passenger (60-69) lumps cruise / RoPax / tourist
   together. (high) — ITU-R M.1371; MDPI Electronics 2024; VT Explorer.
2. **The code is manually entered and frequently wrong/missing** — historical
   studies report **18-74%** wrong/missing vessel-type; ~70k vessels/yr
   self-report "fishing"; 10-15% unassignable, with year-over-year swings from
   vessels switching codes. Never trust it alone. (high) — GFW; NOAA/USF.
3. **AIS static numeric fields are sparse/unreliable.** Draft is missing/zero up
   to ~80% of vessels (≈10-20% for ships >30 m); vessels broadcast conflicting
   static values within a year. → Don't make hull length/draft the *primary*
   signal; they're a sanity-check (better for the >30 m commercial fleet we
   care about). (high) — Hilliard/Meyers et al., Ocean Engineering 2022.
4. **Hull-geometry checks work only at broad-class level.** A beam(L)/draft(L)
   residual + logistic-regression scheme catches grossly mislabeled vessels but
   has weak freight discrimination (Cargo AUC 0.66) and **cannot** split
   RoRo/container/bulk or RoPax/cruise. Use as a guardrail, not a solver. (high)
5. **ML on AIS features can do what the code can't — but unproven for us.**
   Geometry ML hit 97% cargo-subtype (single wind-farm channel); kinematics RF
   hit 92% five-class (small single-strait preprint). Neither tested on
   Med/Italian traffic, and neither targets RoPax-vs-cruise. Transferable
   insight: **max SOG (speed)** strongly separates passenger/cruise/HSC from
   cargo — cargo can't reach passenger top speeds. (medium) — MDPI; arXiv 2509.18109.
6. **Practitioners (GFW) never use the broadcast code** — they join 30+ public
   registries on durable identifiers + a behavior CNN. The transferable part is
   the **registry join on IMO/name**, not the (fishing-oriented) taxonomy. (high)
7. **Use IMO, not MMSI, as the durable key.** MMSI identifies the radio, changes
   on reflagging/sale, and is often a placeholder (123456789, 412000000; ~4%
   invalid in a USCG study). Registries usually lack MMSI → join on IMO + name +
   call sign + flag. AISstream broadcasts IMO + name in static (type 5) messages.
   (high) — GFW; USCG NavCen.
8. **Equasis is the key external resource for our hard case.** Free, EMSA-hosted,
   ~85k+ merchant ships >100 GT, with a free-text ship type that **distinguishes
   "Passenger/Ro-Ro Cargo Ship" from "Passenger (Cruise) Ship"** — exactly the
   RoPax-vs-cruise split. Caveats: data can be incomplete/contradictory, not
   real-time, **no bulk API** (rate-limited/captcha). → Pre-build an
   IMO→ship-type lookup for the *closed, enumerable* set of vessels serving
   Italian ports; use as a cross-check alongside the operator list. (high) —
   Equasis/EMSA; Bellingcat toolkit.

**Refuted (do NOT use):** the claim that RoPax broadcasts 60-69 *because* SOLAS
classes it a passenger ship (0-3 against).

## How this shaped our shipped rule (validated)

`isFreightVessel(shipType, name)`:

- **cargo (70-79)** → freight (container / RoRo / bulk), always.
- **passenger (60-69)** → freight only if a **freight RoPax operator** (GNV,
  Moby, Tirrenia, Grimaldi, Corsica Sardinia, Caronte, SNAV) — excludes cruise
  lines + tourist ferries that also broadcast "passenger".
- **tanker / HSC (40-49) / other** → excluded.

Operator freight/tourist flag is single-sourced in `italy-ferries.data.json`
(`operators[].freight`). We deliberately use the operator (not hull size) as the
RoPax signal, because live data showed size-alone catches 300 m cruise ships.

## Hardening path (logged, not yet built)

1. **Equasis IMO→ship-type lookup** for the closed Italian-port fleet → verified
   per-hull RoPax-vs-cruise, replacing/augmenting the operator allowlist. (Biggest
   accuracy win; one-time build since no bulk API.)
2. **Join on IMO + name** (from static msgs), filtering placeholder MMSIs.
3. Optional **max-SOG sanity check** to flag obviously-mislabeled vessels.

## Open questions (good roadmap items)

- What fraction of the live aisstream.io Italian feed populates IMO + a usable
  name? (Measure directly — the registry join depends on it.)
- Mixed-fleet operators: Grimaldi/GNV run pure RoRo cargo **and** RoPax **and**
  cruise-adjacent units — does the line-name heuristic over/under-include? Equasis
  per-hull type disambiguates.
- HSC (40-49): exclude wholesale (current), or filter by operator/route?
- Is there an enumerable, maintainable IMO→ship-type reference (Equasis bulk
  export / Spire / MarineTraffic) to replace the operator allowlist per-hull?

## Sources

- AIS static data quality — Hilliard/Meyers et al., Ocean Engineering 2022: https://www.sciencedirect.com/science/article/abs/pii/S0029801822016596
- NOAA/USF vessel-type assignment & hull-geometry verification: https://repository.library.noaa.gov/view/noaa/49215/noaa_49215_DS1.pdf
- Ship classification from AIS + ML (MDPI Electronics 2024): https://www.mdpi.com/2079-9292/13/1/98
- Kinematics RF vessel classification (arXiv 2509.18109): https://arxiv.org/abs/2509.18109
- Global Fishing Watch — Vessel Identity Data: https://globalfishingwatch.org/datasets-and-code-vessel-identity/
- GFW — Matching broadcasts to vessel registries: https://globalfishingwatch.org/data/matching-broadcasts-vessel-registries/
- GFW — Spoofing / shared identities: https://globalfishingwatch.org/data/spoofing-one-identity-shared-by-multiple-vessels/
- Equasis (EMSA) — About: https://www.equasis.org/EquasisWeb/public/About
- Equasis via Bellingcat toolkit: https://bellingcat.gitbook.io/toolkit/more/all-tools/equasis
- MarineTraffic — AIS ShipType significance: https://support.marinetraffic.com/en/articles/9552866-what-is-the-significance-of-the-ais-shiptype-or-vessel-type-number
- VT Explorer — AIS ship type reference: https://api.vtexplorer.com/docs/ref-aistypes.html
