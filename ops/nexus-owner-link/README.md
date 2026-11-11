# ARGUS × NEXUS owner link — first integration slice

Branch `claude/argus-nexus-owner-link-20261111` (from `origin/main` f22d862). **Not deployed. Not merged.** The interface NEXUS has to implement is in [CONTRACT.md](CONTRACT.md).

**State in one line:** the ARGUS side is built and tested; NEXUS has no receiver, owner account or activation page yet, so NEXUS synchronisation is **pending** and the UI says so.

## What exists now

| Piece | File | Notes |
|---|---|---|
| Migration (8 new tables, nothing altered) | `backend/migrations/20261111_nexus_owner_link.sql` + `.down.sql` | Additive, idempotent, reversible |
| Owner link service | `backend/services/nexusOwnerLink.js` | Invitations, claims, verification, disputes, sync gate, outbox, inbound events |
| Tokens and request signing | `backend/services/nexusLinkCrypto.js` | Plaintext invitation tokens are derived, never stored |
| Agency distribution routing (addendum 01) | `backend/migrations/20261111b_nexus_distribution_routes.sql`, `backend/services/nexusDistributionRouting.js` | Immediate / after N days / on a date / selected audience / none; clock starts at agency approval; needs a matching owner grant; revocable; idempotent release. **API only — no screen yet** |
| Freshness classifier | `backend/services/availabilityFreshness.js` | Reads `properties.last_confirmed_available_at`; no second timestamp |
| Staff API | `backend/routes/crmOwnerNexus.js` → `/api/crm/owner-nexus/:ownerId/…` | Admin, or agent with `feature_entitlements.nexus_owner_link = true`, checked on the live row |
| Service API for NEXUS | `backend/routes/nexusLinkService.js` → `/api/nexus-link/v1/…` | HMAC-signed; 503 until a secret is configured |
| Route registration | `backend/index.js` | Production `index.js` (md5 bc53d588…) plus 5 lines |
| Owner profile UI | `components/crm/owner-nexus-panel.tsx`, NEXUS tab in `app/crm/owner/[id]/page.tsx` | One actions menu, status card, per-property statuses |
| Deploy script | `deploy.sh` | Written, **not run** |

### Operator controls (owner profile → NEXUS tab → "NEXUS actions")

| Control | What it does |
|---|---|
| Invite owner to NEXUS | Creates a secure activation link and shows it for copying. Sends nothing. Refused for do-not-contact owners and owners without a complete listing. |
| Copy invitation link | Shows the same link again; counts the copy. |
| Replace invitation link | New link; the old one stops working. |
| Revoke invitation | Invalidates the link. |
| Confirm ownership verified… | Staff state how ownership was checked. Only possible after the owner claimed the profile. |
| Open dispute… / Resolve dispute… | Stops sync for the owner until resolved; resolving returns to "claimed", not "verified". |
| Sync owner to NEXUS | Queues name + link ids only. Verified owners only. |
| Sync properties to NEXUS | Queues each property that passes the gate; lists the reason for each one that does not. |
| Retry sync | Makes failed events due again. Never duplicates. |
| Manage distribution | Shows what the owner authorised (read-only: the owner decides in NEXUS). |
| Open NEXUS profile | Enabled once verified and `NEXUS_OWNER_PROFILE_URL` is set. |

### Configuration (all unset by default — unset means off)

| Env | Purpose |
|---|---|
| `NEXUS_LINK_INBOUND_SECRET` (≥32 chars), `NEXUS_LINK_INBOUND_KEY_ID` | Lets NEXUS call `/api/nexus-link/v1`. Unset: 503. |
| `NEXUS_OWNER_LINK_URL` (https), `NEXUS_LINK_OUTBOUND_SECRET` (≥32 chars), `NEXUS_LINK_KEY_ID` | Where ARGUS delivers events. Unset: events stay pending. |
| `NEXUS_OWNER_PORTAL_URL` | Base of the invitation link. Default `https://nexuslink.fit/owner/activate` — **this page does not exist yet.** |
| `NEXUS_OWNER_PROFILE_URL` | Base for "Open NEXUS profile". |
| `NEXUS_INVITE_SECRET` | Invitation token key; falls back to a key derived from `JWT_SECRET`. |
| `NEXUS_INVITE_TTL_DAYS` | Default 14. |
| `NEXUS_AVAILABILITY_INTERVAL_HOURS` / `_APPROACHING_HOURS` / `_STALE_HOURS` | Freshness thresholds. Defaults 48 / 36 / 336. |
| `ARGUS_AGENCY_KEY` | Default `2906`. |

## Audit: what was already there (and is unchanged)

| Area | Where | Finding |
|---|---|---|
| Owner records | `owner_contacts`; `properties.owner_id` | One owner, many properties. No NEXUS fields before this slice. |
| Owner profile API/UI | `routes/crm.js` `GET /owners/:id`; `app/crm/owner/[id]/page.tsx` | Untouched apart from the new tab. |
| NEXUS marketplace sync | `routes/nexusBridge.js`, `services/nexusBridge.js` | NEXUS **pulls** the public `GET /api/nexus/inventory`; unauthenticated, listable records only, no owner data. Untouched. |
| Availability freshness | `properties.last_confirmed_available_at`, `services/boardAction.js` | Already the single source. Reused; the contract calls it `availability_last_confirmed_at`. |
| Property Source Sync | `ops/property-source-sync` | Inbound, read-only, permission-gated. Untouched. |
| Client sync | Google Sheet → `clients` (`clientSheetSync`, `sheetsSync`) | Untouched. |
| Swipe / share links | `swipe_links`, `shareLinks.js` | Untouched; a test asserts no rows change. |
| Owner outreach, WhatsApp | `outreach*`, `waha.js`, `availabilityReachout.js` | Untouched; the new module cannot load WAHA or the queues in tests. |
| Tenancy | `agency_key` on two tables only | Core tables (`owner_contacts`, `properties`) have no agency column. See limits. |
| NEXUS side | `D:\2906\NExususu`, live mirror v97 | No owner account, invitation, owner↔property link, distribution model, property viewing schedule or service-to-service auth. |

## Tests actually run (2026-11-11, local)

Database: local embedded PostgreSQL 16 with the production **schema** (dump of 2026-11-01, 288 tables) and no production rows. The NEXUS receiver is an in-process stub.

| Suite | Result |
|---|---|
| `backend/test/ownerLink.test.js` (services) | 18/18 |
| `backend/test/distributionRouting.test.js` (7-day delay, owner authorisation, revocation, concurrency) | 8/8 |
| `backend/test/routes.test.js` (real routers, real JWTs, real signatures) | 4/4 |
| `tests/owner-nexus.test.cjs` (Chromium, mocked API; 1440 / 390 / 360 px) | 3/3 |
| `tsc --noEmit` | No new errors (6 pre-existing in `calendar_interna` and `lib/crm/ui.tsx`) |
| Existing `tests/availability-agent-links.test.cjs`, `availability-owner-routing.test.cjs` | 1/1, 1/1 |

Run:

```bash
# once: local database (needs embedded-postgres, pg, express, jsonwebtoken, express-rate-limit on NODE_PATH)
ARGUS_TEST_PGDIR=<dir> ARGUS_SCHEMA_SQL=<schema-only.sql> node ops/nexus-owner-link/backend/test/helpers/localDb.js serve
# backend
cd ops/nexus-owner-link/backend
ARGUS_BASE_DIR=<production mirror with db.js and services/boardAction.js> node --test --test-concurrency=1 test/ownerLink.test.js test/routes.test.js test/distributionRouting.test.js
# UI (needs `next dev -p 3117 --webpack`)
CRM_MOCK_BASE=http://localhost:3117 node --test tests/owner-nexus.test.cjs
```

### Acceptance scenarios

| # | Scenario | Status |
|---|---|---|
| 1 | Existing owner linked without duplicates | Tested |
| 2 | Operator generates and copies a valid invitation | Tested (service, HTTP, UI) |
| 3 | Existing swipe links keep working | Tested as "no rows touched, module does not reference them"; no swipe code changed |
| 4 | Approved property syncs to NEXUS | Tested **against a stub receiver only** |
| 5 | Unapproved property does not publish | Tested |
| 6 | Owner permission changes enforced | Tested (narrowed scopes, revoke, withdrawal) |
| 7 | Agency-private records inaccessible to other agencies | Tested for the new link tables and events. Core tables are single-tenant — see limits |
| 8 | Permitted source sync does not modify its source | Tested for this sync (owner and property rows byte-identical). Property Source Sync's own read-only guarantee is unchanged and was not re-run |
| 9 | Availability confirmation updates the right timestamp | Tested |
| 10 | Unrelated answer does not reset freshness | Tested |
| 11 | Viewing breaks and booking conflicts | **Not built** in this slice |
| 12 | Property Sync and Client Sync still work | No code of theirs changed; their suites were **not re-run** (they need the VPS test container) |
| 13 | NEXUS Marketplace sync still works | `nexusBridge` untouched; the deploy script probes `/api/nexus/inventory`. Not run against production |
| 14 | 2906 commercial attribution preserved | Tested: `originAgency` and provenance in every payload; `listed_by_agent_id` untouched |
| 15 | Retries create no duplicates | Tested |

## Limits and decisions to confirm

1. **NEXUS receiver does not exist.** Invitation links point at a page NEXUS has not built. Do not hand links to owners until it has.
2. **Single-tenant core tables.** `owner_contacts` and `properties` have no agency column, so "which agency owns this owner" is the instance (`ARGUS_AGENCY_KEY`), not a row attribute. Benestates data must not be loaded into this instance on the assumption that the link tables separate it.
3. **Owner says "rented" in NEXUS** → ARGUS files it as "Rented?" for an agent to confirm, like the existing owner-reply rule. Kev to confirm that a structured portal answer should not flip the listing directly.
4. **Freshness thresholds** (36 h / 48 h / 14 days) differ from the board's colour ladder (30 h / 60 h). The board is unchanged; aligning them is a product decision.
5. **Who may use the controls:** admins, plus agents explicitly entitled. No agent is entitled by default.
6. **Delivery is operator-triggered** (Sync / Retry). No cron job was added. Scheduled releases are stored durably, but they only fire when `POST /api/crm/owner-nexus/routes/process-due` is called; wiring that into `cron.js` is a separate change because the live `cron.js` could not be matched to a mirror by md5.
7. **Properties added after the invitation** are not proposed to the owner automatically; a new invitation or a later "propose properties" action is needed.

## Planned, not built

Structured Q&A · viewing schedule consumption · scheduled owner reconfirmation prompts (outreach untouched) · photos in the payload · commission and referral model · B2B sharing workflow · agency source connections · a screen for distribution routing · ARGUS Light and smart defaults (queue addendum 01) · global profiles and sector streaming (queue addendum 02).

## Deploy (needs explicit approval)

`deploy.sh` follows the guarded VPS procedure (exact-base md5, backup, additive migration, syntax check, restart, probes, printed rollback). With no NEXUS env set it enables no traffic in either direction. The frontend ships with the normal Vercel build from `main` after merge.
