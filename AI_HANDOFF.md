# AI_HANDOFF — durable project state

## Current objective
Stabilise ARGUS outreach end-to-end, then work through `REPAIR_BACKLOG.md` one bounded task at a time.

## Repository / branches
- Repo `soxtrm/2906-website`, branch **`claude/outreach-yes-fix`** (worktree `nexus-bridge-work/20260926/outreach-yes-fix`), based on `origin/main` 63dd8b8.
- Backend changes are in `ops/outreach-approval-fix/` (production snapshots committed first, then the diffs).

## In flight / ownership
- Outreach approval + `!createlist`: this branch. Files: `services/adminCommands.js`, `services/outreachApproval.js`, `services/outreachApprovalStore.js`, `services/whatsappReachability.js`, `services/listBuilder.js`, migration `20261017_outreach_pending_approvals.sql`.
- **Conflict warning:** Codex's untracked `link-mobile-cards/ops/outreach-control/backend/services/outreachApproval.js` has the same path and different content. Do not deploy that folder without diffing against production.

### 2026-10-17 Outreach YES approval (Claude)
Changed: adminCommands.js, new outreachApproval.js (commit ee3e858, 27d27d6)
Why: human YES within 4 s swallowed as echo; accepted YES silent; `!yes` unknown; expired previews silent; 40/40 recipients not on WhatsApp; report hid failures (`ops/outreach-approval-fix/AUDIT.md`)
Tests: `node --test test/outreachApproval.test.js` → 16/16 (9/12 of the original set fail on the old file); live A1–A9 PASS (see matrix)
Deployed: **yes**, 2026-10-17 16:28 UTC, backup `/opt/2906-system/backups/outreach-approval-20261017T1628Z`
Not verified: EDIT live; behaviour after restart in prod (needs migration)

### 2026-10-17 Durable approvals (Claude)
Changed: outreachApprovalStore.js, adminCommands.js, migration (commit 9140181)
Tests: 16/16 incl. restart / expiry-after-restart / two instances; store + migration on real Postgres 16 (8 concurrent claims → 1)
Deployed: **no** — needs migration on production + redeploy of adminCommands.js and the store

### 2026-10-17 `!createlist` reachability (Claude)
Changed: listBuilder.js, whatsappReachability.js, adminCommands.js header (commit 19fae7d)
Tests: 5/5; live read-only classification of batch 276: 40 NOT_REGISTERED, controls VALID
Deployed: **no**

### 2026-10-17 Ops cleanup (Claude)
Stopped a 44-day-old `until docker exec … clientAssistant.js` loop on the VPS (PIDs 2695065, 3827124, 3827147).

## Outstanding failures
- Google Sheets: SA has read-only access to "hjggj"; required tabs missing (human action).
- `!viewdate`: no handler located (only in help text).
- WAHA sessions Argus2/4/5, Gabriela need QR.
- Backend is not under source control (934 `.bak` files).

## Next bounded assignment
T2 in `REPAIR_BACKLOG.md`: apply migration `20261017_outreach_pending_approvals.sql` + deploy store/listBuilder/whatsappReachability/adminCommands with the md5-guarded deploy script, then live-test A10 (restart) and `!createlist 5`.
