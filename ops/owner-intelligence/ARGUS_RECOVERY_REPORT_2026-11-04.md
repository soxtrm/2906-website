# ARGUS owner intelligence and WhatsApp recovery — engineering report

Date: 2026-11-04

Branch: `codex/argus-owner-recovery-20261104`

Base: `dc1b2ce7552004fb65e5c05503b0e4653cb73e5a` (`origin/claude/owner-pipeline`)

Implementation commit: `f827123`

Deployment: **No.** No production database migration, service restart, WhatsApp send, outreach or live owner action was performed.

## Isolation

- The implementation worktree is `D:\2906\nexus-bridge-work\20261104\argus-owner-recovery`.
- Dirty/shared checkouts and unrelated user changes were not modified.
- The unrelated travel instruction comes from the active hourly Codex automation `nexus-ortsmagazin-nachtarbeit` (`C:\Users\kevin\.codex\automations\nexus-ortsmagazin-nachtarbeit\automation.toml`). It remains active and unchanged; no travel repository was edited.
- `D:\2906\NExususu` is the separate Nexus Booking/restaurant CRM and was not used for ARGUS data or changes.

## Findings and outcomes

### 1. Property interpretation — FIXED in branch; production UNVERIFIED

Root causes:

- `RENTED_RE` treated historical sentences such as “rented four years ago” as current status.
- One status action was applied to every conversation property, so a multi-unit owner reply could rent an entire portfolio.
- Availability, future availability, refurbishment, photos and viewing eligibility were not independent facts.
- A previously misclassified rented listing was excluded from later correction resolution.
- Fact supersession was field-wide instead of property/unit-specific.

Changes:

- `services/conversationPolicy.js`: unit selectors for ref/type/bed/floor/unit number; historical/current/future/viewing/refurbishment separation; safe ambiguity review; protected-group compliance handling; correct `€1,700` parsing.
- `services/conversationIntelligence.js`: full owner portfolio is available for explicit unit resolution, while unconstrained statements stay inside verified context; canonical writes occur only for one resolved unit; recent corrections can restore `AVAILABLE` without auto-publishing; property-aware fact supersession and status audit history.
- Mixed “two rented, one available” statements no longer rent all units. The available studio can be updated, while unidentified rented units create a targeted review task.

Before: historical or ambiguous “rented” language could destructively update all linked listings.

After: only verified canonical property IDs change; ambiguity pauses automation and creates review work.

### 2. Repeated or contradictory replies — FIXED in branch; production UNVERIFIED

Root causes:

- Duplicate protection covered exact drafts only.
- Older summaries could remain active after a correction.
- The latest reason for a skipped/failed response was not persisted for the UI.

Changes:

- `services/responseDedup.js`: near-duplicate fingerprint/Jaccard guard.
- Inbound revision and outbound claim idempotency remain message-ID based and are now asserted by regression tests.
- Explicit corrections supersede the same fact for the same property, not facts belonging to other units.
- Processing events record review, agent takeover, policy suppression, duplicate response, preflight block and dispatch failure reasons.
- The direct reply planner no longer says a property was removed when the owner says it is available.

### 3. AI state and manual takeover — FIXED in branch; full worker path PARTIAL

Root causes:

- A healthy WAHA connection was displayed as if it implied active AI.
- The Board relay path did not reliably mark a manual agent message as an AI takeover.
- Operators could not see why an inbound message received no automatic response.

Changes:

- `services/automationStatus.js` and `services/conversationRecovery.js` distinguish `AI Active`, `Agent Takeover`, `AI Paused` and `Connection Error`.
- Explicit pause/resume is owner-gated, audited and does not bypass opt-outs.
- Manual Board text and attachment sends call the existing `ownerAssistant.handleHumanMessage` takeover path.
- The chat header shows connection state, automation state, the latest processing reason and permitted controls.

Partial boundary: the full production WAHA/worker/job chain was not executed because live communication was prohibited. The deployed `bookRelay.js` runtime source is also not tracked in this branch’s owner-intelligence mirror, so its exact delivery-ack transition remains an integration dependency.

### 4. Closed conversations — FIXED in branch; production UNVERIFIED

- Added an authenticated, agent-scoped reopen route.
- Reopen changes only the latest closed `book_relay_threads` row, clears `close_reason`/`closed_at`, and writes an audit activity.
- Reopen does not mutate the property, viewing or AI status and does not silently resume AI.
- History remains rendered while closed; a fallback reopen control remains available even if automation health cannot load.

### 5. Durable history and idempotency — PARTIAL

- Existing `book_relay_messages` remains the durable timeline.
- Migration adds source ID, delivery status, agent attribution and referenced property IDs.
- An additive database trigger backfills and enriches old/new relay rows during a staged rollout, including messages written by an older service process.
- Per-thread source IDs are unique; inbound revisions and outbound reply claims remain idempotent.

Partial boundary: the browser rendered the API-backed durable timeline and migration persistence is verified, but a complete page-reload/service-restart test against the production-equivalent untracked `bookRelay.js` was not possible. Final provider delivery acknowledgement still depends on that runtime/delayed-send service updating `wa_message_id`.

### 6. Owner Facts and compliance — FIXED in branch; production UNVERIFIED

- Compact sourced chips show value, confidence, last confirmation and pending clarification.
- Agents can correct or dismiss facts; corrections run transactionally and project availability/price/date/condition changes into canonical records with audit history.
- Restricted nationality/ethnicity statements are stored as compliance-restricted evidence, flagged for review and never converted into matching filters.
- Fact edits are scoped to the listing’s owner/property. Relay reads and reopen operations are scoped to the authenticated agent.

Cross-tenant classification: **PARTIAL**. The current 2906 schema is agent-scoped and does not expose a separate tenant/agency key in this route; agent/owner/property isolation is asserted, but a true second-tenant integration fixture does not exist in this mirror.

## Files changed

- `ops/owner-intelligence/backend/services/conversationPolicy.js`
- `ops/owner-intelligence/backend/services/conversationIntelligence.js`
- `ops/owner-intelligence/backend/services/responseDedup.js`
- `ops/owner-intelligence/backend/services/automationStatus.js`
- `ops/owner-intelligence/backend/services/conversationRecovery.js`
- `ops/owner-intelligence/backend/routes/crmScheduleBoard.js`
- `ops/owner-intelligence/backend/migrations/20261104_conversation_recovery.sql`
- `ops/owner-intelligence/backend/migrations/20261104_conversation_recovery.down.sql`
- `components/crm/board-dialogs.tsx`
- `app/crm/crm.css`
- `ops/owner-intelligence/backend/test/conversationRecoveryPolicy.test.js`
- `ops/owner-intelligence/backend/test/conversationRecoveryContracts.test.js`

## Verification

- Recovery policy/contract tests: **23 passed, 0 failed**.
- Required acceptance cases covered: multi-unit status, historical rental/current correction, no congratulatory repeat, December/photos, takeover/reason, explicit resume contract, pause vs connection failure, closed read/reopen without property mutation, durable IDs/idempotency, Owner Facts provenance/controls, agent-owner-property scoping and discriminatory-preference isolation.
- `node --check` on changed backend services/routes: passed.
- `npx tsc --noEmit`: passed.
- `npm run build` with Next.js 16.2.0: passed (52 static pages generated).
- Migration in disposable PostgreSQL 16: up → repeated up → down → up passed; trigger backfill/new-row metadata verified; original `close_reason` survived rollback.
- Playwright with simulated CRM responses and no live backend/WhatsApp: desktop 1280×720 and mobile 390×844 passed; 0 console errors after the mocked session loaded.
- ESLint could not run because this repository has no `eslint.config.*` compatible with installed ESLint 10. No lint configuration was invented in this sprint.
- Dependency install reported pre-existing audit findings in the lockfile; no broad dependency upgrade was attempted as part of this recovery.

## UI evidence

- `evidence/2026-11-04/owner-chat-desktop.png`
- `evidence/2026-11-04/owner-chat-facts-expanded-desktop.png`
- `evidence/2026-11-04/owner-chat-mobile.png`

## Rollout and rollback

No rollout was performed. If authorized later, apply the additive migration before backend routes/services, then deploy the frontend. Keep the down migration and the pre-deploy database backup as rollback points. Do not enable or test against a real owner; use the authorized simulated/test number and observe processing/delivery events first.
