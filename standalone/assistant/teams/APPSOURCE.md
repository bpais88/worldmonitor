# Publishing Marco to the Teams Store / AppSource — runbook

The pick-when-ready playbook for the public one-click **"Add to Teams"** link. A Teams Store
listing **auto-lists on AppSource too** — one submission, not two. Doc-cited against MS Learn
(2025–2026). **No Microsoft fee at any rung** — the real cost is engineering time on the
review loop.

## Distribution ladder (where to stop depends on the goal)

| Rung | Review | Reach | Use when |
|---|---|---|---|
| **Sideload** (Upload a custom app) | none | you / one team | dev + your own tenant — *done* |
| **Org catalog** (Teams Admin Center → Manage apps → Upload) | tenant admin only | one org's users | **design partners — live today, no Microsoft review** |
| **Teams Store / AppSource** | Microsoft validation | global, self-serve | public "Add to Teams" |

**For your first customers, use the org catalog** (§ "Design-partner shortcut") — no review, no publisher verification. Only do the full Store submission when you want *strangers* to self-install.

## Prerequisites for the Store (the long poles)

1. **Partner Center developer account** (free, company account). Goes through verification: Email Ownership (link valid 7 days), Employment (~2 hours), Business (1–2 business days). Until done: *"This account is not publish eligible."*
2. **Publisher Verification** — the blue "verified" badge, **required** for Store apps and aimed exactly at multitenant apps like Marco. Free, "verified in minutes" *once* you have:
   - A **Partner One ID** for a verified **Microsoft AI Cloud Partner Program (CPP)** account, as the org's **partner global account (PGA)** — **getting CPP/PGA verified is the schedule's long pole (days–weeks) if you don't already have it.**
   - The app registration in an Entra work/school tenant (✓ Marco).
   - A **publisher domain** set on the app that is **NOT** `*.onmicrosoft.com` ← gotcha; set a real domain.
   - The CPP-verification email domain matching the publisher domain; the app's tenant associated with the PGA; the user holding App Admin (Entra) + Partner Admin (Partner Center) with MFA.
   - Apply: Entra app registration → **Branding & properties → Add Partner ID to verify publisher**.
3. **Publisher Attestation** (security/data self-assessment) — also required, but you **complete it after the app is listed** (new apps can't do it before).

## Identity posture — already Store-compatible

- Store = cross-tenant by definition; what must be multitenant is the **Entra app registration audience** (`AzureADMultipleOrgs`) — ✓ Marco already is.
- The **Azure Bot ARM resource being "single-tenant" is NOT a blocker** — that's the normal topology (Azure Bot + hosting + app registration in one tenant). Cross-tenant reach comes from the app-registration audience + publishing, not where the resource lives. **No re-architecture needed.**

## Package / manifest deltas beyond sideload

Manifest fields the Store requires (we already have most): `developer.{name(≤32),websiteUrl,privacyUrl,termsOfUseUrl}`, `name.{short(≤30),full(≤100)}`, `description.{short(≤80),full(≤4000)}`, `accentColor`, `icons.color` (192×192), `icons.outline` (32×32 transparent), `bots[].botId` = the Azure Bot App ID (**max 1 bot; never change botId across updates — it wipes all interaction history**), `validDomains` (only domains you control, **no test/non-prod**). **Omit `webApplicationInfo`** — only for SSO, which Marco doesn't use.

Partner Center **store-listing assets** (separate from the manifest, and they **must match** it exactly — mismatches are a top rejection cause): **≥3 screenshots** showing real functionality (1366×768, ≤1024 KB each, up to 5), long description (≤4000), optional YouTube/Vimeo demo video, category.

## Validation — self-check before submitting (400+ tests)

Pre-validate the zip with the automated tool: **https://dev.teams.microsoft.com/tools/store-validation** (also in the Developer Portal for Teams).

**Bot must-fixes (most common rejections):**

- Responds to generic **`Hi` / `Hello` / `Help`** (any case) — a `help` response is **mandatory** and must keep the user **inside Teams** (no external redirect).
- Valid response **even when the user isn't logged in**; **no dead ends** on any input.
- Personal-scope **welcome message** auto-sends **once** on install, app name matching the manifest (✓ — ⑤a does this).
- **Respond within 2s or show a typing indicator.**
- **AI-generated content needs an in-context "AI-generated" indicator + a way to report objectionable content + moderation** — **Marco is LLM-backed, so this APPLIES.** Budget for an "AI-generated · report" affordance.
- No Microsoft product images/avatars; fully responsive on mobile.

**General:** privacy/terms/support URLs must be HTTPS, reachable, **no auth required**; no broken links; no "MS/O365" abbreviations or "#1/best" claims. Provide **test accounts without MFA** that **can upload custom apps**, pre-populated data, a fresh first-run account, test notes, and ideally a demo video (missing/MFA'd test accounts are a common rejection).

## Submission flow

1. Read the [validation guidelines](https://learn.microsoft.com/en-us/microsoftteams/platform/concepts/deploy-and-publish/appsource/prepare/teams-store-validation-guidelines) at design time.
2. Create + verify the Partner Center account.
3. Pre-validate the package (store-validation tool).
4. Complete **Publisher Verification** before submitting.
5. Build the Partner Center listing + test materials (must match manifest).
6. Submit through Partner Center (Marketplace offers → Teams).
7. **Concierge loop:** Microsoft emails a test report (`teamsubm@microsoft.com`) tagging issues Must-fix / Good-to-fix / Blocker / Query → fix + resend until clean.
8. Approval → auto-listed in Teams Store **and** AppSource.

## Timeline + after publish

- First test report **~24 working hours per round**; expect **a few resubmissions** → budget **weeks** total for a first bot.
- After approval: Teams Store in **≥1 business day**, AppSource within **~1 hour**; usage data ~1 week.
- **"Add to Teams" deep link:** `https://teams.microsoft.com/l/app/<AppId>` opens the install dialog (uses the manifest `id` GUID once listed). **Tenant admins can still allow/block** the app in Teams Admin Center.

## Design-partner shortcut (org catalog — no review, live today)

Have the partner's **Teams Administrator**: Teams admin center → **Teams apps → Manage apps → Actions → Upload new app** → upload `marco-teams.zip` → available to their org in a few hours (an *admin* upload needs no separate approval). This is how to onboard real customers **before** tackling the Store.

## What to do first (recommended order)

1. **Set a real publisher domain** on the app registration (not `*.onmicrosoft.com`) — unblocks publisher verification.
2. **Get CPP/PGA verified** (the long pole — start early).
3. Add the **AI-generated content indicator + report affordance** (validation requirement for LLM bots).
4. Onboard design partners via the **org catalog** meanwhile.
5. Then run the Store submission loop.

### Key MS Learn sources

- Publish overview · submission-checklist · teams-store-validation-guidelines · common-reasons-for-app-validation-failure
- Partner Center account + marketplace submit · publisher-verification-overview / mark-app-as-publisher-verified
- Manifest schema (root) · apps-package · manage-apps (org catalog) · deep-link-application
