# Freight Monitor — standalone scaffold

European maritime freight monitoring: live AIS port congestion, vessel delays and ETAs,
disruption intelligence (strikes, water levels, chokepoints), and Marco, the freight
assistant (Slack / Teams / Telegram / WhatsApp / voice).

This directory is the **extraction staging area**: the ferry/freight product lifted out
of the worldmonitor fork it grew up in, with upstream-licensed (AGPL) code replaced by
clean-room implementations. It is designed to be copied out as the root of its own
repository.

## Status

| Piece | State |
|---|---|
| Backend modules (25 + tests) | moved as-is — 285/285 tests green |
| Marco assistant | moved wholesale — 155/155 tests green |
| Frontend (logistics + Freight components) | moved as-is; builds, typechecks clean |
| Panel / sanitize / i18n / vite config / api plumbing | clean-room rewrites (headers explain each) |
| Relay HTTP entry | clean-room, characterization-tested — 16 tests incl. fail-closed auth |
| Trips lifecycle (Phase B) | ported and wired — 10 wiring tests |
| Parity vs the fork's relay | 15/15 identical (`npm run parity`) |
| e2e | 4 Playwright smoke tests against the real relay + a production build |
| CI | `.github/workflows/ci.yml` (test, typecheck+build, e2e) |

Everything runs standalone: `npm run relay` serves live data with no dependency on the fork.
What remains is infrastructure — **[CUTOVER.md](CUTOVER.md)** is the step-by-step runbook,
and PARITY_MANIFEST.md tracks how every feature is verified.

## Layout

- `index.html` + `src/` — the web app (Vite + TypeScript, no framework)
- `scripts/` — relay-side domain modules, tests, DB migrations
- `assistant/` — Marco (its own deployable; `assistant/railway.json`)
- `api/` — Vercel edge proxies (`/api/ais-*` → relay)
- `.github/workflows/` — CI (test/typecheck/e2e), freight monitor, SAR sweep, assistant eval, voice drift

## Commands

```
npm install
cp .env.example .env  # RELAY_SHARED_SECRET is required — the relay refuses to boot without it
npm test              # relay modules + assistant + edge-proxy auth (301 + 155 + 5)
npm run typecheck
npm run build
npm run test:e2e      # boots the real relay + a preview build, drives it with Playwright
npm run dev           # web app on :3000
node scripts/relay.cjs  # the relay on :3004
```

## Provenance & license boundary

All product code here was authored post-fork in this project's own history (verified by
a per-file creation + blame audit against the full upstream history). Files that were
upstream-authored in the fork (Panel, sanitize, i18n, vite config, api/_relay, the relay
HTTP entry) are replaced by clean-room implementations written from their observed
interfaces — each carries a header saying so. The upstream worldmonitor project is AGPL
and none of its code is included here. With the relay entry rewritten, that boundary is
complete: no file in this tree derives from upstream source. See PARITY_MANIFEST.md for
what remains before cutover and how each item is verified.
