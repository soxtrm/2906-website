# ARGUS conversation intelligence hotfix

## Scope

This patch makes the inbound owner message the authoritative event. It stores the message revision and field-level facts first, applies property/contact state, resolves direct questions, and validates every automated draft again immediately before send.

No live WhatsApp send or production deployment was performed while preparing this patch.

## Production baseline inspected read-only

Host: `root@178.104.162.193`

Backend root: `/opt/2906-system/backend`

Captured before editing:

- `services/ownerAssistant.js`: `88b961c5...`
- `services/ownerFactEngine.js`: `522ffeb2...`
- `services/autoOwnerConversation.js`: `d422b24f...`
- `services/ownerPortfolioCheck.js`: `4986f8c0d8931c2086105b4532d1426b45f21d43c9c5bca5c0405d465729206e`
- `services/outreachPlanner.js`: `d386cd18...`
- `routes/webhook.js`: `7844a002...`

The complete hashes should be re-read on the deployment run. Abort if any production file changed after this inspection; reconcile those changes instead of overwriting them.

## Added behavior

- `conversationIntelligence.js` is the single ordered inbound decision path.
- `ownerPortfolioCheck.js` applies “None” only to the exact numbered snapshot and records that question context for later short replies.
- `conversationPolicy.js` interprets status, corrections, restrictions, compliance risk, direct questions and short contextual answers.
- `agentIdentityRegistry.js` binds identity to the sending account: Kevin/2906, Cedric/QuickLets, Gabriella/Sotheby's.
- `message.edited` uses a body revision fingerprint, so a real edit is processed while duplicate deliveries remain idempotent.
- Facts retain entity/property/account, status, source message/time, confidence, effective time, supersession and last confirmation.
- Rented/sold/withdrawn updates unpublish only the resolved properties and suppress/remove incompatible queued collection jobs.
- Ambiguous property status changes stop automation and require human review; the bot never claims an unresolved listing was updated.
- Contract-only/non-occupancy language activates compliance review and human takeover.
- Final send gates are applied to auto-owner collection, owner assistant check-ins and scheduled outreach.

## Database migration

Apply `ops/owner-group-flow/backend/migrations/20261016_conversation_intelligence.sql` before copying or enabling the JavaScript changes. It adds:

- `conversation_intelligence_state`
- `conversation_message_revisions`
- `conversation_facts`
- `conversation_outbound_guard`
- `property_operational_status_history`

The migration is additive. Rollback is application-first: restore the previous JavaScript files and restart the backend. Keep the new tables for audit/history; they do not affect the old code. Drop them only in a separately reviewed data-retention change.

## Validation

Run from the repository root:

```powershell
node --check ops/owner-group-flow/backend/services/conversationIntelligence.js
node --check ops/owner-group-flow/backend/services/conversationPolicy.js
node --check ops/owner-group-flow/backend/services/agentIdentityRegistry.js
node --check ops/owner-group-flow/backend/services/autoOwnerConversation.js
node --check ops/owner-group-flow/backend/services/ownerAssistant.js
node --check ops/owner-group-flow/backend/routes/webhook.js
node --check ops/outreach-control/outreachPlanner.js
node --test tests/conversation-intelligence-hotfix.test.cjs
node --test tests/owner-group-flow.test.cjs
git diff --check
```

## Deployment sequence requiring explicit approval

1. Re-read production hashes and create a timestamped backup of every target file plus the database migration state.
2. Apply the SQL migration.
3. Copy the reviewed service/route files to their matching production paths. `ops/outreach-control/outreachPlanner.js` maps to `/opt/2906-system/backend/services/outreachPlanner.js`.
4. Run `node --check` on production copies before restart.
5. Restart only the backend/worker units that load these modules.
6. Keep global owner automation paused and run redacted fixture replays first.
7. Enable one allowlisted test owner, verify database facts, queue cancellation, message idempotence and sender identity.
8. Enable broader traffic only after explicit approval of the fixture and allowlist result.

## Known operational ambiguity

Numbered-property questions must call `recordQuestionContext()` with the exact displayed property IDs. The new handler correctly scopes a later “None” to that stored set; any legacy sender that emits a numbered list without recording the context must be wired before relying on that reply form.

## Production deployment — 2026-10-16 04:41 UTC

- Re-read all six production baseline hashes before writing; each matched the reviewed baseline above.
- Saved the original application files, environment file and pre-migration PostgreSQL schema under `/opt/2906-system/backend/.rollback/conversation-intelligence-20261016T0438Z`.
- Paused `AUTOMATION_LIVE` while applying the additive migration and replacing the reviewed modules. No live WhatsApp message was sent by the deployment checks.
- Production `node --check` passed for every replaced or added module. Module loading and redacted policy fixtures passed for property-scoped rented/withdrawn handling, account-scoped identity and compliance escalation.
- Confirmed all five migration tables, restarted only the backend container for the final activation, restored `AUTOMATION_LIVE=1`, and left `AVAILABILITY_AUTO_REACHOUT=0` unchanged.
- Backend health returned `ok`, the public schedule board loaded 72 listing cards with its reference/village search visible, and the browser console had no errors or warnings.
- Application rollback is the timestamped directory above. The additive audit tables remain harmless with the previous code and should only be removed in a separately reviewed retention change.
