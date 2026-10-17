# Repair backlog — ordered, one bounded task each

Each task: reproduce → failing test on real handler → fix → test passes, old code fails → md5-guarded deploy (authorised) → live check → `AI_HANDOFF.md`.

| # | Pri | Task | Inputs / evidence | Needs approval for |
| --- | --- | --- | --- | --- |
| T1 | P0 | Put `/opt/2906-system/backend` under git (init from the running files, commit as-is, push to a private repo); deploys from that repo only | 934 `.bak` files, no git on prod | creating the repo |
| T2 | P0 | Deploy durable approvals + `!createlist` reachability (branch `claude/outreach-yes-fix`), then live-test restart (A10) and `!createlist 5` | matrix A10, B1 | migration + deploy |
| T3 | P0 | Reconcile Codex's untracked `ops/outreach-control/backend/` with production: diff file by file, keep what is better, resolve the `outreachApproval.js` name clash, commit | `ARGUS_CODEX_FAILURE_DIAGNOSIS.md` §1, §5 | — |
| T4 | P0 | Owner reply interpretation regression set (Michael "Nr 3 available only", "None", "All", price correction, IDK) against the **current** prod `availability.js` vs Codex's untracked version | spec, redacted real conversations | — |
| T5 | P1 | `!viewdate`: reproduce; locate or implement on the existing property-dates path | only in `handlers/help.js` | deploy |
| T6 | P1 | Reminders: execute `!reminders`, `!remindernow`, `!done`, `!cancelreminder` live in notes chat (read-only commands first) and record actual output | matrix C | — |
| T7 | P1 | Google Sheets: operator shares the intended spreadsheet with `id-906-bot@system-494523.iam.gserviceaccount.com` (Editor) or corrects `config.sheets.spreadsheetId`; then verify read + one write to a test tab | E1 | operator action |
| T8 | P1 | Clean pool data: classify all `owner_contacts` from `pshop_import_20260829` / `imported_list` with `whatsappReachability` (read-only report first) | B1 | marking contacts |
| T9 | P1 | WAHA: re-link Argus2/4/5, Gabriela (QR, human) | E2 | operator |
| T10 | P2 | Remove the stale root-level `backend/adminCommands.js` duplicate after confirming nothing requires it | cmds inventory | deploy |
