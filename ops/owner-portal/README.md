# ARGUS Owner Portal + Owner Viewing Desk — MVP (16 Nov 2026)

Branch `claude/argus-owner-portal` (from `main` `ca51c76`). **Not merged, not deployed. No invitation was sent.**
Audit: [AUDIT_2026-11-16.md](AUDIT_2026-11-16.md).

## What it does

| For | Where | What |
|---|---|---|
| Owner / property manager | `2906.estate/owner-portal` | Permanent portal opened from a one-time personal link. Viewing desk (week calendar + request inbox, drag-and-drop, tap/keyboard-to-assign), weekly availability (durations 10/15/20/30/60/120/custom, break between viewings, daily break, notice, horizon, days off, one-off changes, manual or automatic proposals, copy to other properties), property facts/photos/documents (sent for review), distribution destinations with sync states, property links for agents, property managers, activity log, notification preference. |
| Agents (any agency) | `2906.estate/property-link/<token>` | Owner-approved facts, free viewing times only, structured viewing request (client requirements). Then a private request page `…/property-link/request/<token>` to follow, reconfirm with the client, ask for another time or cancel. |
| ARGUS staff | CRM owner profile → **Owner portal** tab | Founding-owner pilot status (Interested → Pilot invited → Onboarding → Active pilot → Feedback received), invitation / recovery link (identity method required, link shown once, **nothing is sent**), revoke, sign out everywhere, pause/resume, review queue for owner changes. Admins, or agents whose live row has `feature_entitlements.owner_portal = true`. |

### Viewing states

`REQUESTED → OWNER_SLOT_PROPOSED → AGENT_CLIENT_CONFIRMATION_PENDING → CONFIRMED`, plus `DECLINED`, `RESCHEDULE_REQUESTED`, `CANCELLED`, `EXPIRED`, `COMPLETED`, `NO_SHOW` (`backend/services/viewingStates.js`).

- A proposed slot **holds** the time in `property_viewings` (status `pending`); only `CONFIRMED` maps to `confirmed`. Nothing earlier is shown as confirmed.
- The agent message is exactly: *"Viewing slot proposed for #REF on DAY at 4:00 PM. Please confirm availability with your client and reconfirm in ARGUS."* It is recorded on the request and shown on the agent's request page (`delivered: false`; no WhatsApp).
- Unconfirmed proposals expire (2 h before the viewing, at most 48 h) and free the slot: `portal.expireDue()`.
- Auto-approval only ever proposes inside the owner's rules; the agent still reconfirms.

### One calendar, one property identity

No second calendar and no property copy: time is held in `property_viewings` (existing overlap constraint → `SLOT_CONFLICT`), availability is materialised into `property_viewing_windows` with `source_type='owner_portal'`, and every row points at `properties.id`. Bookings made through the existing board flow appear read-only in the desk ("handled by your agent") and still block the time; that flow is not changed (flow freeze, `ops/owner-group-flow/AVAILABILITY_CONTRACT.md`).

### Separation and access control (enforced in SQL, tested)

- Owner queries are `WHERE properties.owner_id = <account owner>`; delegates additionally `id = ANY(<their properties>)` and a scope check (`schedule`, `requests`, `inventory`, `sharing`). Anything else is 404.
- Owner projection is an allow-list (no compliance notes, conversation summary, commission, internal notes, outreach). Agent projection is smaller (no street, no owner name or contact).
- Agents only ever see their own request; free slots never say who holds the busy ones; the owner sees every request with the client requirements.
- Tokens: invitation `inv_`, session `ses_`, share link `shr_`, request `req_`; 256-bit random; only SHA-256 stored; not interchangeable (a share or request link is never a session). The invitation travels in the URL fragment and is removed from the address bar; the session is an `httpOnly; Secure; SameSite=Strict` cookie separate from `crm_session`.
- Owner edits are proposals for staff review; commission, `longlet_price` and any field outside the allow-list are refused (`FIELD_NOT_EDITABLE`). Accepting records the decision; the listing is then edited in the existing editor.
- Allowing a distribution destination never connects it (`pending_approval`); NEXUS Marketplace and owner-direct are shown as not available yet.
- Fees: none are charged or computed anywhere.

## Tests run (local only)

| Suite | Result |
|---|---|
| `backend/test/schedule.test.js` (rules, CET/CEST, exceptions, buffers, state machine) | 7/7 |
| `backend/test/portal.test.js` (real HTTP + Postgres 16: staff gating, invitation lifecycle, identity separation, token separation, rules → windows, share page allow-list, two-stage confirmation, cross-agency double booking, buffers, reschedule/expiry, auto-approval, review queue, private media, property manager scopes and revocation, distribution, legacy bookings, suspension, pilot, audit) | 17/17 |
| `tests/owner-portal.e2e.cjs` (Chromium, `next build` + `next start`, desktop 1440 light/dark, phone 390, 360) | 34/34 — `docs/evidence/owner-portal-2026-11-16/results.json` |
| `npx tsc --noEmit` | only the pre-existing `lib/crm/ui.tsx:446` error |
| `next build` | pass |

**Database caveat.** The suite ran against `backend/test/helpers/coreStub.sql`, a stub of the production tables it touches (inferred from the repo snapshots), not the production schema. Before deploying, re-run it against a schema-only dump of production:

```bash
OWNER_PORTAL_SCHEMA_SQL=<schema-only.sql loaded into a local DB> OWNER_PORTAL_TEST_DSN=postgres://test@127.0.0.1:55440/argus_owner_test \
NODE_PATH=<pg + express> node --test --test-concurrency=1 ops/owner-portal/backend/test/
```

Things the production schema may differ on: extra `NOT NULL` columns on `property_viewings` / `property_viewing_windows`, the exact overlap constraint (statuses covered), `properties.images` / `feature_tags` types.

Local walkthrough: `node ops/owner-portal/backend/test/devServer.js 3911` (sample owner, properties and requests in a local DB), then `OWNER_PORTAL_BACKEND=http://127.0.0.1:3911 npx next build && npx next start -p 3300`, then `node tests/owner-portal.e2e.cjs`.

## Deployment plan (needs founder approval at each step)

1. **Security fix first** (separate task): staff `auth()` must refuse owner-upload tokens; see AUDIT §3.
2. Re-run the backend suite against the production schema dump (above).
3. Backend (guarded VPS procedure, like `ops/nexus-owner-link/deploy.sh`): backup DB; apply `migrations/20261116_owner_portal.sql` (additive, reversible with `.down.sql`); copy `services/{ownerSchedule,viewingStates,ownerPortal}.js` and `routes/ownerPortalRoutes.js`; in `index.js`:
   ```js
   const op = require('./routes/ownerPortalRoutes')({ db, staffAuth: auth, portalUrl: 'https://2906.estate/owner-portal', shareUrl: 'https://2906.estate/property-link' })
   app.use('/api/owner-portal', op.owner); app.use('/api/owner-share', op.share); app.use('/api/crm/owner-portal', op.staff)
   ```
   `db` must be a `pg` Pool (`query` and `connect` for transactions); check what production `db.js` exports.
   Plus a 5-minute `op.portal.expireDue()` timer (or a cron entry). Restart, probe: `/api/owner-portal/me` → 401, `/api/owner-share/x` → 404, `/api/crm/owner-portal/1` without auth → 401.
4. Frontend: merge to `main` → normal Vercel build. Nothing is visible until staff create an invitation.
5. Pilot: once the interested owner's identity is confirmed by the founder, set her to *Pilot invited* in the Owner portal tab, create the link and hand it over personally.
6. Rollback: remove the 3 `app.use` lines and restart; `.down.sql` drops only the new tables and the `owner_portal` windows.

**Before real use:** the Next → backend hop is still plain HTTP to a raw IP (same as every existing proxy). Owner sessions would cross the internet unencrypted until the backend gets TLS or a private network path.

## Not built yet

- **Viewing Desk §4 (owner chat + knowledge sync):** no WhatsApp panel and no extraction of owner statements into facts. Owner-entered conditions (e.g. "Only small dogs") are captured as reviewed property facts and shown in the assignment check.
- Notification delivery (preference is stored; digest every 2 h is the default; nothing is sent).
- Agent identity verification for external agents, referral-fee acceptance step before a viewing, ARGUS-agent requests from the board (they still use the existing booking flow).
- Phase D (ARGUS agent UI refresh, "A" control, island/safe-area fixes) and Phase E (partner/NEXUS distribution).
- Staff panel was verified through the backend suite only, not in a browser (needs a CRM login against a backend).
