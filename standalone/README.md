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
| Relay HTTP entry | **NOT YET PORTED** — the one remaining rewrite; see PARITY_MANIFEST.md §2 |

Until the relay entry exists, this scaffold has no live data source of its own —
the frontend and Marco still point at a deployed relay via env config.

## Layout

- `index.html` + `src/` — the web app (Vite + TypeScript, no framework)
- `scripts/` — relay-side domain modules, tests, DB migrations
- `assistant/` — Marco (its own deployable; `assistant/railway.json`)
- `api/` — Vercel edge proxies (`/api/ais-*` → relay)

## Commands

```
npm install
npm test              # relay module suites + assistant suites
npm run typecheck
npm run dev           # web app on :3000
npm run build
```

## Provenance & license boundary

All product code here was authored post-fork in this project's own history (verified by
a per-file creation + blame audit against the full upstream history). Files that were
upstream-authored in the fork (Panel, sanitize, i18n, vite config, api/_relay, the relay
HTTP entry) are replaced by clean-room implementations written from their observed
interfaces — each carries a header saying so. The upstream worldmonitor project is AGPL
and none of its code is included here. The relay entry rewrite (in progress) completes
that boundary; see PARITY_MANIFEST.md for what remains and how each item is verified.
