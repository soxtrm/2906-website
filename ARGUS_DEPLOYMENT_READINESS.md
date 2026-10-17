# Deployment readiness — outreach (2026-10-17)

## Running in production now
| File | Since | md5 | Source |
| --- | --- | --- | --- |
| `services/adminCommands.js` | 2026-10-17 16:28 UTC | = `ops/outreach-approval-fix/backend/services/adminCommands.js` @ ee3e858 | branch `claude/outreach-yes-fix` |
| `services/outreachApproval.js` | 2026-10-17 16:28 UTC | = repo @ ee3e858 | same |
Rollback: `cp /opt/2906-system/backups/outreach-approval-20261017T1628Z/services/adminCommands.js /opt/2906-system/backend/services/ && rm /opt/2906-system/backend/services/outreachApproval.js && docker restart 2906_backend`

## Ready, not deployed (needs explicit OK)
1. Migration `ops/outreach-approval-fix/backend/migrations/20261017_outreach_pending_approvals.sql` (new table only; idempotent; verified on Postgres 16).
2. `services/outreachApprovalStore.js`, `services/whatsappReachability.js`, `services/listBuilder.js`, updated `services/adminCommands.js` (commit 19fae7d).
Order: migration → files → `node --check` in container → restart → live A10 (restart during approval) + `!createlist 5` on Cedric.
Guard: production `listBuilder.js` must still be md5 `c3399b3b41033b3180f8594c2b508c1e`, `adminCommands.js` must equal the 16:28 deploy; no `outreach_batches.status='running'` / `outreach_runs` claimed|running.
Fail-open: if the migration is missing the store logs once and approvals stay in memory (current behaviour).

## Verified
Live A1–A9 (single authorised recipient, provider ack 2 = DEVICE), local 16/16 approval + 5/5 list, real PG16 store test.

## Not verified
A10 in production, A12 EDIT live, `!createlist` live after deploy, everything in matrix sections C–D.
