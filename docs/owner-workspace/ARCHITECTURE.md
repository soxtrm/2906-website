# ARGUS Owner Workspace, Viewing Calendar and Booking Bridge

Status 2026-11-18: Phase A (audit + architecture) done, Phase B (owner UI) built as a
local preview on demo data, Phase C/D designed with a validated draft schema.
Nothing is deployed: the ARGUS security gate is still open (see "Release gates").

Audit basis: production backend snapshot 2026-11-18 15:20 UTC
(`D:\2906\nexus-live-mirror\argus-backend-20261118T1520Z`), website/CRM repo at the
release base `127e7e8`, NEXUS repos, `PHASE_A_AUDIT_2026-11-17`.

## 1. What already exists

| Area | Existing module | State |
|---|---|---|
| Owner identity | `owner_contacts` (live), legacy `owners` (outreach), `owner_account_labels` | live, two identities, phone-variant duplicates |
| Invitation / claim / verification | `services/nexusOwnerLink.js` (contract `2026-11-11.v1`): `nexus_owner_links`, hashed invitations (14 d), claims, `markVerified` with method + agent, disputes; CRM tab `components/crm/owner-nexus-panel.tsx` | built, dormant (no secret, scheduler off) |
| Owner inputs | `nexus_owner_property_updates`, `nexus_owner_viewing_schedules`, `nexus_owner_answers` | accepted only from verified owners, no staff apply flow |
| Owner portal | `services/ownerBookingPortal.js`, `/api/public/owner-booking/:token`, page `app/owner-schedule/[token]` | live, one plaintext token per owner×property, 14 d sliding / 90 d max, no rate limit |
| Bookings | `property_viewings` (GiST overlap exclusion, trigger to `calendar_events`), `property_viewing_windows`, `bookingEngine`, `bookFlow`, `bookingSurvey`, `bookingOwnerAsk`, `bookRelay` | live, four writers, 2–3 status columns, no idempotency |
| External calendars | `property_calendar_feeds`/`blocks`, `calendarSync` (30 min) | live (short-stay occupancy) |
| Contact access | `POST /api/crm/reveal` + `pii_reveal_log` + daily limit; relay masking `scrubForOwner` / `maskPhonesForDisplay` | live; no `!info`, no access request, no referral terms (Codex branch only) |
| Permissions | `middleware/staffAuth.js` (role from DB per request), `agentPermissions.js` (WhatsApp commands), board scope | hotfixed 17 Nov; `routes/crm.js:148 auth` NOT hardened |
| Agencies | free-text `agency_key` on `nexus_*` / outreach | no agency table |
| Rooms | none (`sharedAccommodation.js` parses text; `unit_group_root_id` groups siblings) | missing |
| Distribution | `nexus_distribution_grants` (7 channels × 5 scopes), `nexus_distribution_routes` (draft → released → revoked), `nexus_sync_outbox`, `website_properties` | built, dormant on the NEXUS side |
| Audit | `agent_activity_log`, `property_activities`, `owner_portfolio_events`, access log (90 d) | no owner actor anywhere |
| CRM UI | `lib/crm/ui.tsx` shell, `crm.css` tokens, `booking-dialog`, `rental-modes`, `components/ui/*` (shadcn), puppeteer tests with `crm-mock` | live |
| Spatial | `spatial-studio` (SVG plan editor, rectangles in plan coordinates, walkthrough) | local prototype, no isometric rendering |
| NEXUS social | `nexus_social.py` + classic `social-signals.mjs` live; React rebuild ports only one read-only line | see Workstream 3 |

## 2. Architecture

```
owner.2906.estate ──► Next app/owner/*  (own layout, own identity, no CRM chrome)
                         │  lib/owner/store  ← preview: fixtures | release: owner API
                         ▼
             /api/owner/*  (Next route, cookie owner_session, HttpOnly)
                         ▼
ARGUS backend  routes/ownerWorkspace.js  ── requireOwner (session table, scope from owner_account_members)
   ├─ properties / property_offers / property_rooms / property_floor_plans   (canonical property)
   ├─ property_viewing_windows  + property_viewings(request_state …)        (ONE booking engine)
   ├─ property_distribution_settings → nexus_distribution_grants/routes → nexus_sync_outbox
   ├─ owner_threads / messages  ←→ bookRelay masking ←→ WhatsApp (WAHA, existing sessions)
   └─ audit: property_viewing_events, property_activities (actor = owner account)
```

Rules that carry over unchanged: `properties.last_confirmed_available_at` is the only
availability confirmation; NEXUS talks to ARGUS only through the signed contract; 2906 and
Benestates never share rows (`agency_key` on every owner table).

### Data model (draft: `ops/owner-workspace/backend/migrations/20261118_owner_workspace.draft.sql`)
Validated on a throw-away copy of the 18 Nov backup (runs clean, ends in ROLLBACK).

- **Canonical property** stays `properties`. Operating modes become `property_offers`
  (one active per property, history kept via valid_from/valid_to); legacy price columns are
  written from the active offer so no reader breaks.
- **Rooms**: `property_rooms` (stable id = property + room_no), `property_floor_plans`
  (plan JSON in spatial-studio coordinates, source + accuracy).
- **Owner identity**: `owner_accounts` (real sign-in) + `owner_account_members`
  (owner/manager/viewer per owner_contact and property, revocable, `granted_by` records the
  verified NEXUS link or admin) + `owner_sessions` (hashed tokens). Invitation links only
  *start* sign-up; they never are the credential.
- **Agencies**: `agencies` table replaces free-text keys for distribution.
- **Distribution**: `owner_distribution_defaults` + `property_distribution_settings`
  (inherit or override, exclusive agency + end date + what happens after). Effective recipients
  are written into the existing grants/routes and shipped through the outbox; "being removed"
  is the route state until the receiver acknowledges.
- **Viewings**: `property_viewings` gains `room_id`, `request_state`, `request_source`,
  `requester_agency_id`, `client_ref`, `applicant` (objective facts only), `proposed_starts_at`,
  `idempotency_key`, `contact_access_state`; `property_viewing_events` is the audit trail.
- **Walkie-talkie**: `owner_threads` / `owner_thread_messages` (stored masked, channel
  workspace/whatsapp/email).

### Business rules (implemented and tested in `lib/owner/engine.ts`, to be ported 1:1)
- Viewing hours = weekly rules + one-day extras − blocked days/hours; slots derive from them.
- A request is confirmed only by the owner (or delegate); agents/tenants can only request,
  answer, accept a proposed time or cancel. Accepting confirms the viewing, never the tenant.
- No double booking: a whole-property viewing blocks every room at that time; two different
  rooms do not block each other.
- Proposed times must sit inside viewing hours and not on a confirmed slot.
- Competing requests for one slot are shown side by side; requesters never see each other.
- Mode switch is blocked by active tenancy or occupied rooms; confirmed viewings and the
  short-let licence are warnings.
- Distribution: private → nobody; active exclusivity → that agency (+ NEXUS Direct if kept);
  otherwise NEXUS Direct, ARGUS network, approved or selected agencies, selected agents.
  Changes compute the revoked set, which must be delisted.
- No protected characteristics (nationality, ethnicity…) in requests or filters.

## 3. UI component map (`app/owner`, `components/owner`)

| Screen | Route | Components |
|---|---|---|
| Overview | `/owner` | headline of what needs you, `RequestCard`×3, coming up, messages, being-removed, `WeekCalendar compact`, `PropertyCard` grid |
| My properties | `/owner/properties` | `PropertyCard` |
| Property | `/owner/properties/[id]` | hero + facts, tabs: overview, rooms (`RoomPlan` isometric + room cards with drop-to-add photo, offer/stop offering), offer & price (mode switch with checks, price, hide price from agencies), requests, history |
| Calendar | `/owner/calendar` | `WeekCalendar` (week: drag to add hours → every weekday / only this date; month; day with block/unblock), weekly hours table |
| Requests | `/owner/requests` | filters, `RequestCard` (accept / suggest time from free slots / ask / decline), `?compare=` side-by-side |
| Messages | `/owner/messages` | ARGUS Main + agency threads, structured buttons inside messages |
| Agencies & sharing | `/owner/sharing` | defaults, per-property inherit/override, exclusive with end date, live channel states |
| Documents | `/owner/documents` | per property / room, shared-with |
| Settings | `/owner/settings` | notifications, quiet hours, delegates |

Identity: plaster `#f3f4ef`, balcony green `#1f4d3f`, globigerina honey `#b88a3c`, harbour slate
`#1e2b33`; Atkinson Hyperlegible throughout (built for low-vision readers); the one motif is the
louvred shutter (viewing hours, brand mark). Mobile: bottom tab bar + "More" sheet, 46 px targets.

## 4. Reuse vs build

| Need | Decision | Module |
|---|---|---|
| Canonical property | **Reuse** | `properties` (+ `property_offers` beside it) |
| Owner identity / claim / verification | **Reuse** | `nexusOwnerLink` invitation → claim → verify; adds `owner_accounts` for sign-in |
| Owner sign-in / session | **Build** | `owner_accounts`, `owner_sessions`, `requireOwner` (same pattern as `staffAuth`) |
| Password setup links | **Reuse** | `agent_password_resets` pattern (security step 3) |
| Booking engine | **Reuse + extend** | `property_viewings`, `property_viewing_windows`, GiST exclusion |
| Owner decision on a request | **Reuse logic, replace transport** | `ownerBookingPortal.decide` → session-based endpoint with idempotency |
| WhatsApp notifications / relay | **Reuse** | `bookingSurvey`, `bookRelay` masking, `humanDelay` |
| Calendar feeds | **Reuse** | `property_calendar_feeds`/`blocks` (blocks feed the owner calendar) |
| Rooms / floor plan | **Build** | `property_rooms`, `property_floor_plans`; geometry from spatial-studio |
| Isometric room view | **Build (light)** | `components/owner/room-plan.tsx` (SVG, no 3D engine) |
| Distribution | **Reuse + extend** | grants/routes/outbox; adds settings + agencies |
| Contact access | **Reuse** | `/reveal` + `pii_reveal_log`, tied to `contact_access_state`; `!info` waits for referral terms |
| UI kit | **New skin, same patterns** | own tokens; reuses CRM proxy pattern, puppeteer test style, `rental-modes` vocabulary |
| Facebook Messenger ingestion | **Not planned** | personal inboxes are not readable through Meta APIs; the booking link is the path |

## 5. Security and migration risks

1. `routes/crm.js:148 auth` accepts any non-board token signed with `JWT_SECRET` → fix before
   any owner token exists; owner sessions must not be JWTs on the same secret.
2. Owner credentials today are bearer links (plaintext portal token, 30-day upload JWT,
   invitation): the workspace must use sessions; links only start sign-up.
3. Booking writers disagree (status columns, no idempotency, portal decline cancels confirmed):
   route every writer through one transition function before owners can act.
4. Public owner-booking routes have no rate limit and expose applicant profile fields
   (nationality, job): limit + reduce to objective facts.
5. Schema drift: several base tables (`nexus_*`, `book_relay_*`, `pii_reveal_log`,
   `agent_activity_log`) are not in `migrations/` → capture before migrating.
6. Two owner identities (`owner_contacts` vs legacy `owners`) and phone duplicates → membership
   only through verified links, never by phone match.
7. No agency table → distribution must wait for `agencies`; Benestates isolation by `agency_key`.
8. NEXUS layer never ran with real traffic → staged run on the hosted staging stack first.
9. Owner actions unaudited today → `property_viewing_events` + activity rows with owner actor.
10. Pre-existing: `ownerquality` nav key can crash the CRM shell (`lib/crm/ui.tsx:446`).

## 6. Implementation sequence

1. **Gate** (blocking): harden `crm.js` auth, finish the credential window (Kev's pilot),
   rate-limit public routes. Kev confirms the gate.
2. **C1 schema**: apply the draft (backup-v2 gate), backfill offers from current prices and
   `rental_modes`, rooms empty.
3. **C2 owner API** `routes/ownerWorkspace.js` (`requireOwner`): properties, offers, rooms,
   windows, requests (transition function = engine port), distribution settings, threads.
4. **C3 sign-up**: invitation (existing) → verified claim → `owner_accounts` + one-time password link.
5. **D booking bridge**: all writers (board, `!book`, portal, NEXUS `viewing.schedule_updated`,
   booking link) create `property_viewings` rows in `awaiting_owner`; notifications via existing
   WhatsApp flow with buttons that deep-link into the workspace.
6. **E pilot**: one test owner + one test property on staging, then Kev's own property.

## 7. Tests and readiness

- `node --test lib/owner/engine.test.ts`: 8/8 (windows, double booking, room vs whole,
  proposals, actor rules, competing requests, mode blockers, distribution/exclusive/revoke).
- `OWNER_BASE=http://localhost:3141 node tests/owner-workspace.browser.cjs`: 18/18, desktop and
  390 px, no page errors, no backend calls; screenshots in `docs/owner-workspace/screens/`.
- Draft schema: applied cleanly to a throw-away copy of the 18 Nov backup.
- `tsc`: no errors in new files (only the pre-existing `ownerquality`).
- **Release readiness: preview only.** `/owner` returns 404 on 2906.estate and www by design.
  Production needs: gate cleared, C1–C3 built, owner sign-in, Kev's go.

## 8. Release gates (why nothing is live)

- Security NO-GO from 17 Nov is not cleared (credential window not run, `crm.js` auth open).
- Kev's own rule: Booking Bridge and bulk outreach stay paused until the gate passes.
- Product decision recorded 2026-11-12 ("ARGUS Light is a NEXUS Marketplace interface, not
  built in the ARGUS CRM"): this workspace is a separate owner surface under `owner.`, not
  inside the agent CRM; Kev should confirm that this matches his intent.
