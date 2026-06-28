# Teams Setup — Marco on Microsoft Teams

Marco's Teams adapter (`/api/messages`: JWT verify → agent → reply over the Bot Framework)
is **live in production** and verified end-to-end via the Azure Bot's *Test in Web Chat*.
This is the runbook for the Azure/Railway setup and for sideloading the app — including the
gotchas we hit, so they don't bite again.

## Current state (2026-06-28)

- **Azure Bot** `marco-freight` (resource group `marco`) — messaging endpoint
  `https://italy-freight-assistant-production.up.railway.app/api/messages`.
- **App Registration** flipped to **multitenant** (`signInAudience: AzureADMultipleOrgs`) so any
  org can install Marco. The Azure Bot *resource* type stays "Single Tenant" (cosmetic — our
  hand-rolled connector doesn't depend on it).
- **App ID** `e3361fe3-23d1-4608-ba1f-41f3c649435f` — already baked into `manifest.json`
  (`id` + `bots[0].botId`). No placeholder to replace.
- Verified live: receive → JWT verify → agent → freight/weather tools → generation → **reply**.

## Railway env (service `italy-freight-assistant`)

| Var | Value | Notes |
|---|---|---|
| `MS_APP_ID` | the App ID | bot identity; also the inbound JWT `aud` |
| `MS_APP_SECRET` | client secret `Value` | from App Registration → Certificates & secrets |
| `MS_APP_TENANT_ID` | the **home** tenant `a02f5454-…` | **KEEP THIS SET** — see gotcha #2 |

Boot log confirms armed: `[teams] Bot Framework endpoint on /api/messages` (only printed when
`MS_APP_ID` is set).

## The multitenant flip (so any org can install)

1. App Registration → **Manifest** → set BOTH in one save (the Authentication-blade radio fails
   otherwise — see gotcha #1):
   - `"signInAudience": "AzureADMultipleOrgs"`
   - `"requestedAccessTokenVersion": 2`  (inside the `"api"` block)
2. **Leave `MS_APP_TENANT_ID` set** to the home tenant. The connector mints its client-credentials
   token from the home-tenant authority; that token is app-only for `api.botframework.com`
   (validated by appId, not tenant-scoped), so it delivers replies to any conversation the
   Connector routes.

> Multi-tenant *new-bot creation* is deprecated by Microsoft after 2025-07-31 (existing/converted
> bots keep working; modern alternative = single-tenant + user-assigned managed identity).

## Build the app package

`manifest.json` is pre-filled for the prod host. The two icons live next to it
(`color.png` 192×192, `outline.png` 32×32 transparent). Build the flat zip (artifact, gitignored):

```sh
cd assistant/teams && zip -j -X marco-teams.zip manifest.json color.png outline.png
```

(Flat = the three files at the zip root, no folder.)

## Sideload + try it

Teams (a **work/school** account — personal Microsoft accounts can't sideload custom apps) →
**Apps → Manage your apps → Upload an app → Upload a custom app** → pick the zip → **Add**. Then
DM Marco or `@mention` him in a channel: *"which Italian ports are congested?"*
(Custom-app upload must be enabled in the tenant's Teams admin settings.)

## Distribution ladder (the "Add to Teams" equivalent of "Add to Slack")

| Rung | Who | Friction | When |
|---|---|---|---|
| **Sideload** | you / one user | upload zip in Teams | dev + first test |
| **Org catalog** (Teams Admin Center → Manage apps → Upload) | one org's users | admin uploads once | design partners |
| **AppSource / Teams Store** | anyone | Microsoft review (publisher verification + listing) | public, self-serve |

Once in the org catalog or AppSource, the **one-click connect link** is:

```
https://teams.microsoft.com/l/app/e3361fe3-23d1-4608-ba1f-41f3c649435f
```

That deep link opens the "Add" dialog in Teams — the analog of "Add to Slack". (Reuses the same
`/privacy` + `/support` pages Marco already serves for Slack distribution.)

## Gotchas (learned the hard way)

1. **Flipping to multitenant via the Authentication blade fails** with
   `api.requestedAccessTokenVersion is invalid`. Multitenant requires access-token **v2** — set
   `requestedAccessTokenVersion: 2` AND `signInAudience: AzureADMultipleOrgs` together in the
   **Manifest** editor (one atomic save).
2. **Do NOT mint the connector token from the `botframework.com` authority.** A *converted*
   single→multi app has no service principal in Microsoft's `botframework.com` tenant, so it
   returns `AADSTS700016 / unauthorized_client` (you can't admin-consent into Microsoft's tenant).
   Keep `MS_APP_TENANT_ID` set → mint from the **home-tenant** authority, which works. (The
   `|| 'botframework.com'` fallback in `connector.mjs` is therefore a footgun: dropping the env
   var silently breaks every reply.)
3. **A reply must be a COMPLETE Activity** (`from`/`recipient`/`conversation`), or the Connector
   returns 400. The connector builds this from the inbound conversation reference.

## No per-tenant token (unlike Slack OAuth)

The bot uses one global credential and captures a **conversation reference** on first contact.
The frictionless onboarding "magic moment" (Marco DMs the installer "Ciao…") lands when the
`conversationUpdate` capture + onboarding DM are wired — see the proactive/onboarding PR.
