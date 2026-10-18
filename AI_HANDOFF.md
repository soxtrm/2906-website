# AI_HANDOFF — durable project state

## Current objective
Stabilise ARGUS outreach end-to-end, then work through `REPAIR_BACKLOG.md` one bounded task at a time.

## Repository / branches
- Repo `soxtrm/2906-website`, branch **`claude/outreach-yes-fix`** (worktree `nexus-bridge-work/20260926/outreach-yes-fix`), based on `origin/main` 63dd8b8.
- Backend changes are in `ops/outreach-approval-fix/` (production snapshots committed first, then the diffs).

## In flight / ownership
- Outreach approval + `!createlist`: this branch. Files: `services/adminCommands.js`, `services/outreachApproval.js`, `services/outreachApprovalStore.js`, `services/whatsappReachability.js`, `services/listBuilder.js`, migration `20261017_outreach_pending_approvals.sql`.
- **Conflict warning:** Codex's untracked `link-mobile-cards/ops/outreach-control/backend/services/outreachApproval.js` has the same path and different content. Do not deploy that folder without diffing against production.
- Property distribution: `ops/property-distribution-fix/backend/` owns `services/{sanitizer,categoryFormatter,autoOwnerConversation,rentedDetector,ownerPortfolioCheck,availability}.js` and `routes/webhook.js` (all = production as of 2026-10-18 01:22 UTC). **`ops/owner-group-flow/backend/routes/webhook.js` is stale** (not production) — never deploy it.

### 2026-10-18 Property distribution repair (Claude)
Changed (branch `claude/outreach-yes-fix`, `ops/property-distribution-fix/`, each with a prod snapshot commit first):
1. `sanitizer.js` + `categoryFormatter.js` (d4cddc5) — #2906-9481 crash. "Rue" not a street noun → "421 Rue D’Argens" survived upload; render turned "Gżira – 421" into "Gżira, 421", guard threw, category groups + FB scheduling + auto-share + `!recategorize` died. Now strip-then-verify (address and maps link); phones still abort.
2. `autoOwnerConversation.js` (51bcb9e) — `runAutoPublishJob` (auto-publish timer AND `!upload5` claiming an owner-checklist draft) never distributed: 20/22 auto-published listings since 09-11 on `category_groups='pending'`, 0 group posts. Now runs FB campaign → categories → FB group share like cmdUpload.
3. `rentedDetector.js` (61be6b1) — `!rented` / group 😡 / quoted "rented" flipped status but never touched the groups. Now 😡 + threaded "now rented" reply via availability.js.
4. `ownerPortfolioCheck.js` (6c2de59) — all 5 live checks stuck `awaiting_reply`; 12 owner replies dropped ("Nr 3 available only", "Both are rented", "Nothing is available now"). Parser understands natural answers; unclear → Kev alert with the numbered list, never a guess.
5. `routes/webhook.js` (4038dc9) — reconnect flushed only outbound queues; now also the inbound owner catch-up (60 s settle, 10 min debounce).
Tests (`cd ops/property-distribution-fix/backend; node --test test/<file>`): categoryFormatter.address 6/6, autoPublish.distribution 1/1, markRented.groups 2/2, ownerPortfolio.parse 4/4, webhook.reconnectCatchUp 1/1 — each fails on the production file.
Live: all 582 prod payloads re-rendered read-only: 562 identical, 20 previously crashing now render, 0 regressions, 0 leaks; 9481 renders "📍 Gżira" without 421/street. Provider probe on 35699811819: threaded reply ack 2 (DEVICE) with replyTo set, reaction HTTP 200. Existing AV rented flow proven by log (#2906-9386: 😡 1/1, reply 1/1). Reconnect catch-up fired via webhook: checked 237, recovered 0, errors 0. Message-id mapping: 367/367 per-group posts since 08-24 carry `external_ref` + session.
Deployed: yes, each via `deploy-file.sh`/`deploy.sh` (md5 guard, backup under `/opt/2906-system/backups/property-distribution-*`, `autopublish-distribution-*`), VPS md5 = repo md5 (LF).
Not verified / risks: no real auto-publish, `!rented`, or owner portfolio reply has happened since deploy; 9481 not yet re-posted (`!recategorize 9481 3 bed` is the operator's send). Backlog NOT re-processed: ~14 available listings with zero group posts (9453, 9328, 9325, 9275, 9262, 9258, 9228, 9224, 9218, 9217, 146, 139, 135, 112, 092 — several have stale dates) and the 5 open portfolio checks (Jovana "Both are rented", Mario "Nothing is available now" are clear; Michael's later "it has been rented" is ambiguous). Facebook: login lost / proxy dead (273+58 failures) — human re-login needed.
Not built: D−3 reminder preflight, persistent clarification workflow, single-link Agent Property Card (Package 2 already exists), inbound catch-up for `!av` checks (needs an inbound message ledger to dedupe safely).
Next: one bounded task — inbound message ledger table + catch-up for open `!av` checks.

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
