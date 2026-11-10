# ARGUS Owner AI recalibration — release report (2026-11-10)

Branch `claude/argus-owner-ai-recal-20261110` (on top of Outreach P0 `da9cd0b`).
Spec: `ops/owner-ai-recal/spec/` (materialised verbatim from the founder file).

## 1. Why the owner replies were wrong — traced in production

Production has two owner-reply engines per inbound message: the facts engine
(`conversationIntelligence` → `conversationPolicy`) and the checklist engine
(`autoOwnerConversation.processStep`). Evidence comes from `owner_auto_conversations._log`,
`conversation_outbound_guard` and backend logs from 8–10 Nov.

| # | Root cause (code) | Live evidence |
|---|---|---|
| RC1 | Checklist engine is a form-filler: after turn 1 it always asks `nextMissingField`; only agency questions are recognised on later turns | "I'm not sure what you mean" → next field question |
| RC2 | Later turns call `mergeExtracted(…, {}, text)`: facts volunteered outside the field just asked are dropped (price corrections, availability, move-out) | €2,800 + "available" → "when could someone view it?" |
| RC3 | Commercial classification wins over residential evidence (Gemini `propertyCategory`, "garage"/"office" amenities) | bungalow (#6340), villa → "permit or licence status?" |
| RC4 | No studio ontology; room listings still get the `sharing` question | "How many bedrooms?" to a studio; "professional sharing?" to a room |
| RC5 | Subletting pitch hard-coded as the last optional question ("One last question, sorry for the spam…") | #6302, #6319, #6332, #6317 |
| RC6 | `FALL3_NEEDS_HUMAN_TEXT` invents the agent's whereabouts ("I am currently on appointments") | #6327, #5137 |
| RC7 | Video mapped to the `[document]` sentinel → "couldn't open that file … (bedrooms, bathrooms, price, availability)" plus a second question in the same burst | #6292, #5137, #6296 |
| RC8 | No quiet-hours gate on automated owner replies | bot questions at 21:36, 22:19, after midnight |
| RC9 | Viewing offers / call requests not recognised | villa "viewing tomorrow 3 PM" → "how many bathrooms?" |
| RC10 | Facts engine flattened a shared place into a whole-property RENTED (fixed by Codex 14:20 UTC) | guard #75 "removed the property" |
| RC11 | **New regression, 14:20 UTC today:** the Codex release reads `properties.floor_level` (migration never applied) and imports `EMAIL_QUESTION_RE` from an identity registry version that was never deployed → every inbound since then fails in the facts engine (`column "floor_level" does not exist`, 50 errors / 30 h) | backend logs |

## 2. What changed

* `services/ownerDecision.js` — deterministic action contract (`NO_SEND | ANSWER_DIRECT | ACKNOWLEDGE_UPDATE | ASK_SINGLE_MISSING | HUMAN_HANDOFF | WAIT_FOR_MEDIA | DEFER | DNC`) with spec reason codes. The 2026-11-09 turn router is kept and consulted (privacy, auto-replies, fallback).
* `services/ownerDecisionRuntime.js` + patched `autoOwnerConversation.js` (exact-match patch over production md5 `0134df18`):
  - The decision layer runs first on every turn.
  - Facts persist with provenance (`_owner_ai_facts`, `_owner_ai_provenance`); one redacted audit row per turn goes to `owner_ai_decisions`.
  - At most one message per turn, sent through the existing `gatedSend`.
  - DEFER keeps the burst pending and re-reads it at 08:30.
  - DNC uses the existing `markDoNotContact`.
  - Quiet-hours and forbidden-phrase final gates.
  - Subletting pitch retired; truthful handoff text; `[video]` sentinel.
  - Residential guard against permit questions; studio and room ontology.
  - History backfill (never re-ask what the owner wrote).
  - Move-out date is not an availability date.
* `services/agentIdentityRegistry.js` — the founder-verified superset from the 2026-11-09 branch (fixes RC11 import).
* Migration `20261110_owner_ai_recal.sql`:
  - Repairs `properties.floor_level` / `parking_type` (RC11).
  - Decision audit, immutable weekly reports, append-only reviews, fixture candidates, P0 incidents, regression runs.
  - Persisted Monday 08:30 Europe/Malta schedule.
* Weekly quality review:
  - `services/ownerQualityReport.js` measures from real stored conversations.
  - Admin routes `/api/crm/owner-quality/*` and the cron tick (P0 incident scan every 10 min).
  - CRM page `/crm/owner-quality` with four views: Overview, Needs Review (evidence drawer + Approve / Correct / Block), Golden Examples, Releases & Regression.
  - Anonymised export.

Unchanged by design:
- Account Auto/pace settings.
- The template rotation and approval status.
- Paused campaigns.
- Codex's facts-engine files.

## 3. Tests (all executed)

| Suite | Result |
|---|---|
| 136 golden cases → `spec/qa/evaluate_decisions.py --actual` | **136/136** |
| Evaluator self-tests | 7/7 |
| Historical 486 pack — turn router (`ownerGoldenCases.test.js`) | **486/486** |
| Historical 486 — new decision layer, safety + route family | **486/486** (6 documented divergences where the newer 136 pack wins) |
| Real `processStep` on isolated `argus_test`, before → after | before 17 scenarios captured; **after 17/17** |
| Weekly report / schedule / review / export on `argus_test` | **5/5** |
| `/crm/owner-quality` in Chromium at 1440 / 390 / 360 | **3/3** |

Evidence: `evidence/runtime/runtime-{before,after}.json|.tap`, `quality.tap`, `backend/test/out/golden136-traces.jsonl`, `tests/screenshots/owner-quality/`.

## 4. Production deployment (2026-11-10, after the 19:30 Malta send window; 0 active outreach runs)

| Step | Time (UTC) | Backup / rollback |
|---|---|---|
| Outreach P0 backend (`ops/outreach-p0/deploy.sh`) | 18:32 | `/opt/2906-system/backups/outreach-p0-20261110T183219Z` (rollback command printed by the script) |
| Owner AI recalibration backend (`ops/owner-ai-recal/deploy.sh`) | 18:33 | `/opt/2906-system/backups/owner-ai-recal-20261110T183333Z`: restore the 4 files, delete the 5 new ones, restart, then run `20261110_owner_ai_recal.down.sql` |
| Facts-engine hotfix `$9::timestamptz` | 19:13 | `/opt/2906-system/backups/facts-engine-param9-20261110T191308Z/conversationIntelligence.js` |
| Frontend `main` → Vercel | 19:13 | `origin/main` 46e449b (previous d9873bb) |

Installed md5 (live): autoOwnerConversation `5f26ddb0`, agentIdentityRegistry `8680d831`, ownerDecision `407c36f5`,
ownerDecisionRuntime `7a6c59f9`, ownerQualityReport `edc41280`, ownerTurnRouter `d7cbd363`, timeGreeting `7ba8b256`,
routes/crm.js `d5a254d7`, cron.js `82d18fe6`, conversationIntelligence `5e6a7ea4`.

Verified live:
- `properties.floor_level` and `parking_type` exist.
- All 7 `owner_ai_*` tables exist.
- `EMAIL_QUESTION_RE` is exported and `conversationPolicy.interpretInbound` runs.
- `timeGreeting.fixForSend` works.
- Decision smoke check: `ACKNOWLEDGE_UPDATE/STUDIO_EXPLICIT`.
- Weekly schedule next run: 2026-11-16 07:30 UTC (08:30 Malta).
- `/api/crm/owner-quality/*` returns 401 without a session.
- Regression run recorded, code `2e5a1961…`.
- Account Auto/target snapshot identical before and after.
- No V2 config enabled.

First live decisions: 3 × `DEFER/OUT_OF_HOURS` (19:33–20:03 Malta), nothing sent.

Template rotation (Outreach P0 migration, planner_v2):
- The founder-rejected slot-4 morning rows ("reaching out to owners who may have…") for kev, cedric and gabriela are now inactive.
- Gabriela slot 5 (approved in the planner_v2 migration) is in rotation.
- The 24 new persona introductions remain DRAFT.

First real weekly report (`0f291ccf…`, 3–9 Nov, before the fix):
- 275 conversations, 591 owner messages, 603 automated replies.
- 295 issues: 4 P0, 284 P1, 7 P2.
- Release decision HOLD.
- P0 cases: 3 × "removed from listings" for mixed rented/available messages; 1 × "How many bedrooms?" after "you have the wrong person".
