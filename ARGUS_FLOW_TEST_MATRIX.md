# ARGUS flow test matrix — 2026-10-17

Status meanings: **PASS** = executed and observed end-to-end · **PASS (local)** = real handler code, stubbed I/O · **FAIL** = reproduced defect · **PARTIAL** · **BLOCKED** = cannot run yet (reason given) · **NOT TESTED** = nobody executed it. A row is never PASS because code exists.

Production = `/opt/2906-system/backend`, container `2906_backend`, approval fix deployed 2026-10-17 16:28 UTC (backup `/opt/2906-system/backups/outreach-approval-20261017T1628Z`). Live tests: notes-chat events replayed into `POST /webhook/waha`, session Cedric, single recipient 35699811819 (Kev's own admin number), provider ack read from WAHA.

## A — Outreach approval (WhatsApp, notes chat)

| ID | Trigger | Expected | Actual | Evidence | Status |
| --- | --- | --- | --- | --- | --- |
| A1 | YES 1.5 s after preview | ack + exactly 1 run | 1 run, delivered | run eccdc396, ack=2 DEVICE 16:37:47 | PASS |
| A2 | YES ~8 s after preview | same | 1 run, delivered | run 7a6a39d0, batch 279 1/1 | PASS |
| A3 | Quoted YES | same | 1 run, delivered | run d4d9e28e, ack=2 | PASS |
| A4 | YES ×4 incl. duplicate inbound event (same id) | 1 run, "already approved" answers | 1 run, 2× "repeated YES ignored" | run 1467478b | PASS |
| A5 | `!yes` while pending | 1 run | 1 run, delivered | run 7701b642, ack=2 | PASS |
| A6 | `!yes` with nothing pending | explicit answer, no run | 0 runs | log 16:39:41 | PASS |
| A7 | STOP, then YES | 0 runs | 0 runs, "approval cancelled" | approval 68ed5312 | PASS |
| A8 | YES after 5 min expiry | explicit expiry, 0 runs | 0 runs, "approval expired" | approval 4fbe3c33, age 310 s | PASS |
| A9 | YES while `nexus-google-traffic` runs | unaffected | 1 run, delivered | YES 17:00:13.965, job 17:00:13–14, run 5f9012b5 | PASS |
| A10 | Backend restart between preview and YES | approval survives | in-memory only in production | test `restart between preview and YES` | PASS (local) · **BLOCKED in prod**: needs migration `20261017_outreach_pending_approvals.sql` |
| A11 | Two instances, same YES | one run | one run | `two backend instances…` + real PG16: 8 concurrent claims → 1 | PASS (local + real PG) |
| A12 | EDIT then new text then YES | new preview, 1 run | — | — | NOT TESTED (live) · code path unchanged |
| A13 | 40-recipient list without WhatsApp | not armed, operator told | — | test `list with no WhatsApp numbers is not armed` | PASS (local) · live NOT TESTED (no bulk) |

## B — Outreach transport / lists

| ID | Flow | Status | Evidence / root cause |
| --- | --- | --- | --- |
| B1 | `!createlist 40` gives deliverable numbers | **FAIL in prod** · fix PASS (local) | batch 276: 40/40 NOT_REGISTERED (live classification), 29 landlines 3562…, sources `pshop_import_20260829`, `imported_list`; fix in `listBuilder.js` not deployed |
| B2 | Send to number without WhatsApp | PASS (local) | stops after 5 and reports "nothing delivered"; this code is deployed (16:28) but not exercised live (would need non-WhatsApp test numbers) |
| B3 | Report reconciles sent / skipped / failed | PASS (local) | test `other WAHA send failures are reported as failed` |
| B4 | Warm/cold pacing, cooldowns, identity guard | NOT TESTED | unchanged code |
| B5 | Human takeover suppression (12 h) | NOT TESTED | — |
| B6 | Path B (list + text in one paste) sends without YES | behaviour by design, documented | `cmdOutreach` Path B |

## C — Commands (implementation located, not executed)

| Command | Implemented in | Status |
| --- | --- | --- |
| `!outreach`, `!createlist`, `!cancel`, YES/EDIT/STOP | `services/adminCommands.js` | outreach/YES/STOP PASS live; `!createlist` FAIL (B1) |
| `!rented` | `adminCommands.js`, `rentedDetector.js`, `routes/webhook.js` | NOT TESTED |
| `!av`, `!avdate` | `handlers/av.js`, `handlers/upload.js` | NOT TESTED |
| `!viewdate` | **only in `handlers/help.js`** | handler not located → likely BROKEN, needs reproduction |
| `!match`, `!client`, `!calendar`, `!status`, `!CA` | `adminCommands.js`, `matchEngine.js`, `killSwitch.js`, … | NOT TESTED |
| `!reminders`, `!remindernow`, `!summarizereminder`, `!done`, `!cancelreminder` | `adminCommands.js` | NOT TESTED |
| `!upload`, `!gptupload*` | `handlers/upload.js` | gptupload 13/13 in container (2026-10-13, Codex); NOT TESTED live here |

## D — Owner intelligence, reminders, freshness, board, sharing, matching

All rows from the master spec (Michael "Nr 3 available only", "None", price correction, D−3 reminders, 7-day checks, grouped checks, rented propagation, board badges, canonical link, swipe/match, viewing alerts) are **NOT TESTED** in this pass. Codex's `ARGUS_REPAIR_REPORT.md` implementations for these live **untracked** in `link-mobile-cards/ops/outreach-control/backend/` and are **not deployed**; they need the same treatment as the approval fix: commit → diff against prod → real-path tests → authorised deploy.

## E — Integrations

| ID | Flow | Status | Evidence |
| --- | --- | --- | --- |
| E1 | Google Sheets sync | **FAIL** | SA `id-906-bot@system-494523` can read spreadsheet "hjggj" (`1PtKa423…`) but `canEdit:false`; tabs Outreach/Properties/Clients/Rented do not exist (only "Tabellenblatt1"). Needs a human to share the intended sheet with the SA as Editor or correct `config.sheets.spreadsheetId`. |
| E2 | WAHA sessions | PARTIAL | Cedric, kevthirdd, Kevsecond healthy; Argus2/4/5 and Gabriela waiting for QR (log every 2 min) |
| E3 | 15-min traffic job vs workflows | PASS (no interference) | A9; host systemd, no backend restart |
