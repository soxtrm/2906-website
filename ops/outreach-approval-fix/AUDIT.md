# Outreach approval incident — 2026-10-17 (Cedric, batch 276)

Investigated read-only against production (`/opt/2906-system/backend`, container `2906_backend`) on 2026-10-17 16:10–17:00 UTC.

## What actually happened (production log, UTC)

| Time | Event |
| --- | --- |
| 15:06:48 | `!createlist 40` in the Cedric notes chat |
| 15:07:00 | `!outreach` + list |
| 15:07:10 | message text → preview, "Reply *YES* to send" |
| 15:07:12 | `Yes` — **swallowed**: arrived inside the 4 s echo window, no reply |
| 15:07:14 | `Yes` — swallowed / borderline, no reply |
| 15:07:19 | `Yes` — **accepted**, run enqueued; **no acknowledgement** (run engine calls `runDirectOutreach` with `suppressMirroredProgress: true`) |
| 15:07:20 → 16:00 | every send fails: `WAHA 500: no LID found for 356…@s.whatsapp.net from server` |
| — | batch 276 ends `completed`, sent 0 / 40, report line "Skipped: 0" (failures were not counted) |

`!yes` → "Unknown command" because no gate accepted the `!` form and nothing answered it.

## Root causes

1. **Fast YES treated as bot echo.** `handleOutreachStep` swallowed *any* message within 4 s of the preview, including a real human "Yes", without replying.
2. **Silent approval.** After YES the run was queued but the operator got no acknowledgement; progress is suppressed on the run-engine path until the final report.
3. **The list could not be delivered.** All 40 numbers from `!createlist 40` are not on WhatsApp (verified: `check-exists` = false for 40/40 via a second session, while a known number resolves with LID on both). The Cedric session itself is healthy (93 successful sends in 7 days; batch 275 the same morning sent 27/38).
4. **No pre-send reachability check, no early stop, misleading report.** 50 minutes of guaranteed failures; failures not counted in the summary.
5. **Expired previews and `!yes` vanished silently** ("Unknown command" / no reply).

## Yesterday's fix

Not an overwrite and not undeployed: the container (started 2026-10-16 11:11:47Z, RestartCount 0) mounts `/opt/2906-system/backend` and runs `adminCommands.js` of 2026-10-16 11:05 (md5 identical on host and in container). It simply did not touch the causes above.

## 15-minute background job

`nexus-google-traffic.timer` runs `/usr/bin/node /opt/nexus-routing/google-traffic-scan.cjs` on the host — a standalone script, no Docker or backend interaction. The backend container had **no restart** since 2026-10-16 11:11 and the log timeline 15:06–16:00 shows no interleaving with the approval. **No interference found.** The approval flow is now instrumented (`Outreach approval armed / accepted / run enqueued / expired / cancelled / refused`, each with `approvalId` and `runId`) so any future overlap is visible in the log.

## Fix (services/adminCommands.js + new services/outreachApproval.js)

- YES / Yes / yes / Yes. / `!yes` accepted **only while an approval is pending**; a bare decision word is never treated as an echo.
- Immediate acknowledgement with count, session and run id.
- One preview = one `approvalId` = the run's `triggerId` → `enqueueOutreachRun` is `ON CONFLICT DO NOTHING`; repeated YES cannot create a second run and is answered "already approved".
- `!yes` with nothing pending, late YES after expiry, YES after cancel → explicit answer, nothing sent.
- Preview checks every number with WAHA `check-exists` (5 in parallel, fail-open). Numbers without WhatsApp are removed and listed; a list with none on WhatsApp is **not armed**.
- During sending, `no LID found` counts as "not on WhatsApp" (skipped + `outreach_unreachable`), not a transport failure; 5 in a row with nothing delivered stops the batch with an alert. The report states failed / not-on-WhatsApp counts and says "nothing was delivered" when sent = 0.
- Reachout / outreminder confirm gates use the same decision parsing.

Unchanged on purpose: Path B (list + text in one paste sends without YES — existing documented behaviour), pacing, cooldowns, identity checks, run engine, planner.

## Tests

`backend/test/outreachApproval.test.js` drives the real `handleAdminMessage` with the production event shapes (all I/O stubbed, nothing sent): 12/12 pass on the fix, **9/12 fail on the unmodified production file** (including the 2 s "Yes").

## Known limits

- A pending approval lives in process memory for 5 minutes; a backend restart inside that window drops it (a later `!yes` is answered "nothing waiting", a plain Yes is not).
- `!createlist` still produces numbers without WhatsApp; the preview now catches them, but the list builder itself should exclude `outreach_unreachable` / non-WhatsApp numbers.
