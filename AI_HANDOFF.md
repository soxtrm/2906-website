# AI_HANDOFF — durable project state

## Current objective
Stabilise ARGUS outreach end-to-end, then work through `REPAIR_BACKLOG.md` one bounded task at a time.

## Repository / branches
- Repo `soxtrm/2906-website`, branch **`claude/outreach-yes-fix`** (worktree `nexus-bridge-work/20260926/outreach-yes-fix`), based on `origin/main` 63dd8b8.
- Backend changes are in `ops/outreach-approval-fix/` (production snapshots committed first, then the diffs).

## In flight / ownership
- Outreach approval + `!createlist`: this branch. Files: `services/adminCommands.js`, `services/outreachApproval.js`, `services/outreachApprovalStore.js`, `services/whatsappReachability.js`, `services/listBuilder.js`, migration `20261017_outreach_pending_approvals.sql`.
- **Conflict warning:** Codex's untracked `link-mobile-cards/ops/outreach-control/backend/services/outreachApproval.js` has the same path and different content. Do not deploy that folder without diffing against production.
- Outreach automation (2026-10-29, branch `claude/outreach-automation`, NOT deployed): `ops/outreach-automation/backend/` owns `services/{outreachPlanner,adminCommands,outreachRunEngine,cooldownRules,listBuilder}.js`, `routes/crm.js` and 7 new services. On deploy, sync `ops/outreach-approval-fix/backend/services/{adminCommands,listBuilder}.js` to the deployed version (same path, different content until then). `ops/owner-group-flow/backend/routes/crm.js` is already stale vs production — never deploy it.
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

### 2026-10-19 ARGUS functional UI repair (Claude)
Changed (frontend, branch `claude/argus-functional-ui`, commits c16309a + 9bae046, on top of the board-search audit): components/crm/board-filters.tsx, app/crm/schedule-board/page.tsx, lib/crm/ui.tsx (CrmShell `sidebar` slot + header nav + 2906 mark), components/crm/board-dialogs.tsx (AvDateDialog), app/crm/property/[id]/page.tsx, app/crm/crm.css, tests.
Changed (backend mirror, branch `claude/av-repost-dedupe`, commit f9a3245): ops/owner-group-flow/backend/routes/crmScheduleBoard.js — av-date-confirm 10-min cooldown (activity row) + in-flight lock claimed before the first await. Prod md5 before change b427eaaba0a22d3e4e617cc847455277 (= mirror); new md5 80452c441e9da98ba3dcddfe132e0b62.
Why: founder mockups (argusnew/qwerta/arfgzuuss). Save & Repost had no dedupe — two taps or a retry queued two full category-group reposts + two "still on the market" lines (reproduced by the new test against the old file: 2/3 fail).
Tests: `node --test ops/owner-group-flow/backend/test/avDateConfirm.dedupe.test.js` → 3/3 (old code 1/3). `CRM_MOCK_BASE=http://localhost:3109 node --test tests/crm-argus-functional-ui.test.cjs` → 10/10 (x3), crm-mocked-ui 7/7, crm-board-search 7/7, board-compact-facts 1/1, agency-board-admin-tools 3/3, future-property-lock 1/1, `tsc --noEmit` clean. board-clean-desktop.test.cjs asserts the replaced Workspaces/top-rail layout (superseded). board-area-multiselect-mobile + chat-composer-mobile are hard-wired to :4174 (not run).
Deployed: no (frontend not merged to main; backend route not deployed — needs operator OK).
Not verified / risks: no live CRM session used (mocked backend only); real Vercel build not run; desktop 761-1000px only checked by CSS, not screenshot; Smart combinations moved into Tools; !available threaded-reply change NOT prepared.
Next: operator review of screenshots in docs/argus-ui-2026-10-19 → merge `claude/argus-functional-ui`; then deploy crmScheduleBoard.js with deploy-file.sh (md5 guard b427eaab…).

### 2026-10-19 Bug batch (Claude): Rented?, drafts, seafront, gate, Olga, group card
Changed (branch `claude/possibly-rented`, mirror ops/property-distribution-fix/backend): services/availability.js (9028d6f, ce72308), services/categoryClassifier.js (9028d6f), services/ownerSendGate.js (ce72308), handlers/upload.js + handlers/uploadListing.js (09c8623, c1109a6), services/autoOwnerConversation.js (c1109a6), services/categoryPublisher.js (deaa54f). Frontend (main 36dc73c): Rented? chip, bottom island line on sheets.
Why / evidence:
- 71 listings set "rented" by the classifier alone in 30 days → owner "rented" now = pending_check "Possibly rented — owner said: …", shown under the board chip "Rented?"; nothing public changes until an agent confirms.
- #2906-9489 posted to Sea Front on "Easy Access to Sliema Seafront" → only "direct seafront" counts.
- Owner's Facebook ad link read as "could not read it" twice → listing link = still available.
- Board Still available?/Ask refused 40 h ("a person is handling this owner") after anybody typed → explicit agent actions pass bot stand-downs (DNC, contact pause, complaint still block).
- #2906-9502 (Olga "3500€ asking price") stored as SALE → price < €20k is rent (row fixed + website resynced); Olga (agent 2) now broadcasts to category groups (env CATEGORY_BROADCAST_AGENT_IDS, default 1,2); bogus "1 duplicate skipped (#same ref)" removed.
- Owner drafts auto-published + left ref-less staging rows as 2nd cards → no auto-publish (AUTO_PUBLISH_DRAFTS=1 to re-enable), every upload archives the owner's staging drafts; one-off cleanup archived 51 draft rows matched by owner + same town/price.
- Category groups got a 2nd "📍 street / Available / #REF" message → one card: availability marker, description, Viewings/Available, booking + info links; street stays out.
- #2906-9416 was NOT auto-rented: archived "Deleted from CRM" by agent 1 at 2026-10-10 23:20 (together with 9169 in the same second).
Tests (real modules, I/O stubbed, each fails on the old file): possiblyRented 2/2, av-listing-link 8/8, seafrontHint 19/19, av-classify (prod) ok, ownerSendGate.agentAction 5/5, upload.rentNotSale 2/2, drafts.noAutoPublish 3/3, categoryCard.oneMessage 4/4. Live: container check seafront/link verdicts; dry-run preview of #2906-9489 card (bed2, leak check passed).
Deployed: yes, deploy-multi.sh with md5 guard; backups /opt/2906-system/backups/property-distribution-20261019T200318Z, …T201418Z, …T201939Z, …T202431Z, …T202955Z. Repo md5 = prod md5 (CR-stripped).
Not verified / risks: no live owner "rented" reply or real upload observed after deploy; #2906-9489 already sits in Sea Front group (old post, not removed); "Available now" re-marking of an already-posted card when its date arrives is NOT built; 45 open drafts without an upload remain; av-date-confirm dedupe (branch claude/av-repost-dedupe) still not deployed.
Next: watch the first Rented? cases on the board and the next Olga upload in her group.

### 2026-10-20 Outreach shortfall 19.10. (Claude)
Evidence: 19.10. Cedric 10/37 sent (27 skipped "not_on_whatsapp"), kevthirdd 2/32 (30), Argus5 0/15 (14), default 8/33 (25× WAHA 422 "Session status is not as expected"). The "no LID found" numbers were cross-checked with check-exists on Kevsecond (test number → exists): 24/24 really not on WhatsApp. Cause: the 19.10. lists (#282, #266, built 17./18.10.) predate the list-builder WhatsApp pre-check (first ran 2026-10-18 14:19). Lists for 20./21. were rebuilt 19.10. 00:12 → all numbers VALID; Argus5 22.10. (#293) still old → 11/14 not on WhatsApp → rebuilt.
Changed (data only, via outreachPlanner functions; script ops/outreach-approval-fix/backend/scripts/catchup-2026-10-19.js): Cedric + kevthirdd topped up to 40 on 20./21. and new 40-lists on 22./23.; Kevsecond new 35-lists 21./22.; all armed. 20.10. re-armed after the 24h15 cooldown (kevthirdd 08:50, Cedric 09:12 Malta).
default: WAHA session was FAILED; restart → SCAN_QR_CODE (logged out). Needs a QR scan by Kev; plans #303 (20.) / #304 (21.) stay saved (34/37 verified) until then.
Not verified: the 20.10. sends themselves.

### 2026-10-22 ARGUS owner AI + permissions repair (Claude)
Changed: ops/property-distribution-fix/backend/{services/autoOwnerConversation.js, services/agentIdentityRegistry.js, services/conversationPolicy.js, services/canonical2906Renderer.js, waha.js, handlers/upload.js, services/sessionAlertState.js (new), services/agentPermissions.js (new), test/ownerAi.repair.test.js, test/sessionAlert.episodes.test.js, test/agentPermissions.commands.test.js}, ops/property-distribution-fix/deploy-owner-ai.sh, ARGUS_OWNER_AI_AND_PERMISSIONS_REPAIR.md (commits 7458fd5..HEAD, branch claude/possibly-rented)
Why:
- #5598 Argus5 / #5630 Gabriela agency questions escalated: the regex missed "name of your agency", and the registry had no Argus*/"Gabriela" keys.
- #5587 George Cachia: "Next vacancy July '26" read as €26,000/month (bare-digit fallback + x1000 shorthand); "excellent price" fallback copy; past date advertised; restrictions only in notes.
- Olga #2906-9507/9515: told to run admin-only !recategorize.
- QR alert throttle in memory, reset on every restart (3,750 "awaiting QR scan" lines in 7 days).
- Review post could go out via any group member (incl. Cedric) with an invented "was offline" reason.
Tests: node test/ownerAi.repair.test.js → 21/21 (production file: 2/17); node test/sessionAlert.episodes.test.js → 5/5 (production 0/5); node test/agentPermissions.commands.test.js → 8/8 (production 2/8); existing mirror tests pass (autoPublish.distribution already fails on the production file). Live: nothing exercised — read-only SQL/log evidence only.
Deployed: yes 2026-10-22 02:25Z with Kev's OK (backup /opt/2906-system/backups/owner-ai-repair-20261022T022552Z; prod md5 = repo md5 for all 8 runtime files, e.g. autoOwnerConversation f22c9404…, waha a52a8861…, upload 336b1ac5…). Container tests after restart: ownerAi 21/21, sessionAlert 5/5, agentPermissions 8/8, owner-context-firewall 6/6 (was red before).
Data: property 29496 + conversation 5587 corrected (price NULL/MISSING, dates → clarification, restrictions as columns, DISCUSSABLE company lease, cached 'excellent price' copy removed; row backups /opt/2906-system/backups/owner-ai-data-20261022/). Deployed code computes the 3 expected review warnings on the real row.
Owners #5598/#5630: NOT messaged — both were already answered personally on 21.10. (Kev 12:15/15:19, Gabriela 20:10).
Not verified / risks:
- container run of the new tests
- CRM/matching propagation for later draft edits
- board-agent scope limited to listed_by/activity_agent
- no live owner conversation has exercised the new agency path yet (only container tests)
- fb-groups 'Failed to launch the browser process' (189x in the 48h before deploy; pre-existing, unrelated)
- Vertex [Classifier] 403 CONSUMER_INVALID (side finding)
Next: watch the next agency question / QR episode in the logs; fix the Vertex [Classifier] 403 and the fb-groups browser launch separately.

### 2026-10-22 Category rules: direct seafront always wins (Claude)
Changed: ops/property-distribution-fix/backend/services/categoryClassifier.js, handlers/upload.js (!categorygroups rule text), test/categoryRules.20261022.test.js, test/fixtures-9519.json, ops/property-distribution-fix/deploy-category-rules.sh
Why: #2906-9519 ("🌊 Direct Seafront Location", €3,000) went to Luxury. Two causes: (1) the trailing word "Location" matched a proximity disqualifier; (2) the generated description vetoed the agent's text. Kev's rules: direct seafront → ALWAYS seafront; then houses (any villa/house/townhouse/…) and luxury; luxury from €2,500 for every size; bedroom groups below.
Tests: node test/categoryRules.20261022.test.js → 7/7 (production 0/7). Container: categoryRules 7/7, seafrontHint (current version) 19/19, agentPermissions 8/8.
Deployed: yes 2026-10-22 02:35Z (backup /opt/2906-system/backups/category-rules-20261022T023516Z; md5 classifier 54c4dfc5…, upload 3de5f7ac… = repo). The stale production seafrontHint.test.js (August rules, 4 red) was replaced by the mirror version (old copy is in the same backup).
Not verified / risks: #2906-9519 is still posted in the Luxury group (repost needs Kev's OK). 1BR listings at €2,000–2,499 now go to bed1 instead of Luxury (intended by the new rule).
Update 02:43Z: every house type → Houses at any price; luxury only for apartment types (apartment/maisonette/penthouse/studio/duplex …) from €2,500. House is decided by the type or by the agent headline naming a house; the Gemini own-entrance → house path is removed. Deployed (backup /opt/2906-system/backups/category-rules-20261022T024314Z, classifier md5 b555a2c2… = repo). Container: categoryRules 11/11, seafrontHint 19/19, agentPermissions 8/8. In 14 days of posting logs every luxury/villas post already followed this rule; the two closed paths are the ones that could break it.

### 2026-10-29 Outreach automation rebuild (Claude)
Changed (branch `claude/outreach-automation`; prod snapshot eab7791, -text mirror 8086b6a, then 71ef8d3, 569273c, e86081d, 963088d):
`ops/outreach-automation/backend/` services/outreachPlanner.js, adminCommands.js (CRLF kept), outreachRunEngine.js, cooldownRules.js, listBuilder.js, routes/crm.js (CRLF); new services outreachSchedule, outreachPace, outreachQuota, outreachTemplates, outreachTemplateSeed (36 texts), outreachEligibility, outreachEngagement; migration 20261029_outreach_automation(.down).sql; `app/crm/outreach/page.tsx` + `outreach-console.css`; deploy.sh.
Why (evidence from production data):
- Pace "resets to 100": an expired `outreach_volume_until` was read as 100 % by dispatch and listAccounts. Now the saved pace (or min–max range) never expires; no pace → the run is refused (`pace_unavailable`), never 100.
- Evening drift: 24h15 after the last send +16 min a day, no cutoff. Replaced (Kev's choice) by the calendar-day rule: max 40 unique owners per account per Malta day (atomic quota table), sends only 08:30–19:30 (checked before each message; a run reaching 19:30 is held and resumes 08:30). Day chain is +16 min per day from a chosen or auto morning start, and only if 30 min remain in the window.
- Greeting frozen at preparation time: now chosen at send time (persona rotation by period, free text normalised; never "Good night").
- DNC: 210 owners have status='do_not_contact' with the boolean false; pool + canContact only read the boolean; 57 of them were messaged in the last 30 days. Both forms are DNC now, plus a fresh eligibility check before every send (DNC, blocks, dnc/angry labels, pause, unreachable, other-account 20 days, live conversation, no-reply limit 5).
- Hung batches #354–356 (status running since 10-2x): NOT reconciled; the deploy guard ignores running batches older than 2 h.
- Auto/Save All/rolling: autoPrepareAccount (5 days, target 30–40, persona LRU rotation, no consecutive repeat), saveAllPrepared (advisory lock, idempotent, per-day results, ok only when every day scheduled), maintainAutoSchedules from the existing 5-min cron (cron.js unchanged). Engagement + Call Candidates are derived from outreach_log/owner_contacts; opted-out owners are never listed.
Tests: `node --test test/` in the isolated container (argus-outreach-testnet, pgvector pg16 with the prod schema + migration) → 44/44; the same dispatch+planner suites on the eab7791 prod files → 21/26 fail (the 5 that pass call the new modules directly). Migration up/down/up/idempotent on the test DB. `tsc --noEmit` clean. HTTP check of every new route via scripts/outreach-preview-server.js (real routes/crm.js, stubbed WAHA): pace range, invalid pace 400, Auto on → 5×A with variants 1-2-3-4-1, Save All ×2 → 5 scheduled then 5 already_scheduled, quota, template validation (foreign persona 400), engagement, call candidates, Auto off → 5 paused, no token 401. Live: nothing sent.
Deployed: no — needs the operator's OK (migration + restart). Prod md5 still = snapshot for all 6 files (checked 2026-10-29).
Not verified / risks:
- the UI was not rendered in a browser (the local Next dev server hung on a borrowed node_modules); only tsc and the HTTP contract were checked
- the old-code comparison used LF-normalised eab7791 blobs for adminCommands/crm (same content)
- no live run exercised the 19:30 hold/resume or the quota with real WAHA
- the planner keeps proposing owners that dispatch then skips (no_reply_limit, cross-account) — visible as skips, not as a smaller list
- 20-day cross-account window is a setting (outreach_settings), not confirmed with Kev
- 'Rented'-reason DNC owners: decision pending
- outreachPlanner.js was changed in production on 10-28 with no handoff entry (that version is the snapshot base)
Next: with Kev's OK run `ops/outreach-automation/deploy.sh`, enable Auto on one account, watch one morning run in the logs, then sync the outreach-approval-fix mirror copies.
