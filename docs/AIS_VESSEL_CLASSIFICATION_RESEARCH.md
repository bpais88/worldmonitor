# AIS Vessel Classification — Research Notes & Sources

Why this exists: before hardcoding how we tell **freight** vessels (cargo /
RoRo / RoPax) from **tourist/passenger** vessels (cruise ships, tourist ferries,
hydrofoils) from a live AIS feed, we checked how practitioners actually do it.
These notes back the `isFreightVessel` rule in `scripts/ferry-eta.cjs`.

Date: 2026-06-21. Method: targeted web research (the deep-research workflow
stalled in its scope phase, so this was done with direct searches).

## Key findings

1. **The AIS ShipType code is operator-configured and error-prone.** Voyage/
   static fields are entered by the crew and are *less reliable* than
   position-report data; multiple studies exist specifically to characterise and
   correct inaccuracies in reported class and dimensions. Some vessels also
   misreport type deliberately. → Don't trust ShipType for fine distinctions.

2. **AIS cannot distinguish RoPax from cruise.** Both broadcast "passenger"
   (60-69). The real difference is passenger capacity + ro-ro ramps / vehicle
   decks — none of which AIS carries. Cruise ships have *no* ro-ro equipment and
   don't load vehicles; RoPax carry trucks/trailers + passengers. → Use the
   operator/line as the signal, not the code.

3. **Cargo (70-79) includes RoRo-cargo.** A RoRo carrying ≤12 passengers is
   classified as cargo; >12 passengers makes it a RoPax (passenger). → Include
   *all* cargo as freight.

4. **Best practice is registry enrichment.** Accurate type comes from matching
   AIS identity (IMO number, call sign, name, MMSI, flag) against external vessel
   registries (Global Fishing Watch vessel-identity, Equasis, IMO, USCG VIVS),
   needing multiple identity fields to agree. → Our operator-keyword match is a
   **keyless approximation** of this; a real registry is the future upgrade.

5. **ML classifiers reach ~86-90%** using kinematic/trajectory features (CNN /
   random forest on movement patterns) — i.e. ship-type alone is insufficient
   and movement helps. Overkill for us now, but confirms the direction.

6. **Dimensions are often missing/wrong** and static data only broadcasts ~every
   6 min. → Don't make hull length the *primary* signal (this is why we dropped
   the size-only heuristic after live data showed cruise ships at 300m+).

## How this shaped our rule

`isFreightVessel(shipType, name)`:
- **cargo (70-79)** → freight (container / RoRo / bulk), always.
- **passenger (60-69)** → freight **only if a freight RoPax operator** (GNV,
  Moby, Tirrenia, Grimaldi, Corsica Sardinia, Caronte, SNAV) — excludes cruise
  lines (MSC Cruises, Costa…) and tourist ferries (Caremar, Liberty Lines,
  Alilauro…) that also broadcast "passenger".
- **tanker / HSC / other** → excluded (tankers are liquid bulk, not containers;
  HSC are tourist hydrofoils).

Operator freight/tourist split lives in `italy-ferries.data.json`
(`operators[].freight`), single-sourced for TS + the relay.

## Future upgrade (logged)

Replace the operator-keyword heuristic with **IMO/MMSI registry enrichment**
(Global Fishing Watch identity dataset or Equasis) for higher accuracy and to
catch freight RoPax from operators not in our keyword list. This is the
literature's "gold standard" and would also benefit the operator-status explainer.

## Sources

- Vessel classification using AIS data — ScienceDirect: https://www.sciencedirect.com/science/article/pii/S002980182403381X
- Logic Rules Meet Deep Learning: Ship Type Classification (arXiv): https://arxiv.org/pdf/2111.01042
- Ship Classification Based on AIS Data and ML (MDPI Electronics): https://www.mdpi.com/2079-9292/13/1/98
- ML-Based Classification of Vessel Types in Straits Using AIS Tracks (arXiv): https://arxiv.org/pdf/2509.18109
- RO/RO vs ferries (ShipSpotting support): https://www.shipspotting.com/support/15
- What are RoRo Ships? (Marine Insight): https://www.marineinsight.com/types-of-ships/what-are-ro-ro-ships/
- Roll-on/roll-off (Wikipedia): https://en.wikipedia.org/wiki/Roll-on/roll-off
- Global Fishing Watch — Vessel Identity Data: https://globalfishingwatch.org/datasets-and-code-vessel-identity/
- AIS ShipType significance (MarineTraffic): https://support.marinetraffic.com/en/articles/9552866-what-is-the-significance-of-the-ais-shiptype-or-vessel-type-number
- AIS Class A Static & Voyage Data, Message 5 (USCG NavCen): https://www.navcen.uscg.gov/ais-class-a-static-voyage-message-5
- Marine Cadastre AIS Vessel Type & Group codes (NOAA): https://coast.noaa.gov/data/marinecadastre/ais/VesselTypeCodes2018.pdf
