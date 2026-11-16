# Staff auth: refuse owner-upload tokens (16 Nov 2026)

## Finding

`routes/crm.js` → `auth()` verifies any JWT signed with `JWT_SECRET` and refuses only `aud === 'board'`. The owner self-upload link (`GET /owners/:id/upload-link`) signs `{ ownerContactId, aud: 'owner-upload' }` with the **same** secret, valid 90 days, and is handed to owners. Such a token therefore passes `auth()` as a staff session.

Present in **all five** repo snapshots of `routes/crm.js` (outreach-automation, outreach-p0, owner-ai-recal, owner-group-flow, property-inbox). Production was not reachable from the session that wrote this; `deploy.sh probe` checks it.

Routes in `crm.js` that use `auth` without a live-agent or role check (snapshot `property-inbox`, heuristic):
`POST /properties`, `POST /properties/:id/category-override(/reset)`, `POST /properties/:id/images`, `POST /properties/:id/notify-clients`, `POST /upload`, `GET /owners`, `GET /owners/check`, `POST /owners/:id/preferences/:preferenceId/scope`, `PATCH /owners/:id`, `POST /owners/:id/photo`, `POST /owners/:id/automation/start`, `POST|PATCH|DELETE /owners/:id/documents…`, `GET /owners/:id/upload-link`, `GET|POST|DELETE /favourites`, `GET /agents`, `GET /locations`. Some may still fail later on a missing agent id; the owner list and owner edits do not.

Other routers (`crmScheduleBoard`, `crmAgentProfile`, `crmWorkspace`, `crmIntake`, `crmBaseInventory`, `crmPropertySources`, `crmOwnerNexus`, `crmFacebookPages`) re-read the agent row by `payload.id`; an owner-upload token has no `id`, so they already answer 401.

## Fix

One guard in `auth()`, right after the board check:

```js
if ((payload.aud && payload.aud !== 'crm') || !Number.isInteger(payload.id)) {
  return res.status(401).json({ error: 'Session invalid or expired' })
}
```

Staff tokens (`aud: 'crm'`, numeric `id`) are unchanged; board tokens still get 403; pre-audience staff tokens with a numeric id keep working until they expire. The owner-upload route itself (`routes/ownerUpload.js`) is not touched and keeps accepting its token.

## Files

| File | Purpose |
|---|---|
| `apply-crm-auth-fix.js` | Idempotent patcher (dry run by default, `--write` to apply). Refuses a file whose `auth()` differs from the reviewed shape. LF and CRLF. Syntax-checks and restores on failure. |
| `probe.js` | Runs inside `2906_backend`: signs a 2-minute owner-upload token for owner id 0 and calls `GET /api/crm/owners?search=__no_such_owner_probe__`. Prints only the status code (200 = vulnerable, 401 = fixed). No secret and no owner data is printed. |
| `deploy.sh` | Guarded procedure: probe → backup → dry run → patch → syntax check → restart `2906_backend` → anonymous probe → probe. `deploy.sh probe` only checks; `deploy.sh rollback <dir>` restores. |
| `test/crmAuth.test.js` | Runs the real `auth()` from a `crm.js` before and after the patch. |

## Verified here (not on production)

- `test/crmAuth.test.js` against all five snapshots: 3/3 each — the owner-upload token passes before the patch and gets 401 after; staff 200, board 403, legacy staff 200, other audiences / no id / expired / wrong secret 401.
- `deploy.sh` with a stand-in `docker` and a mini server running the real `auth()`: probe 200 before, backup written, CRLF preserved, probe 401 after restart, rollback restores the original byte for byte (same md5).

## Run on the VPS (needs approval)

```bash
cd <repo>/ops/security-staff-auth
./deploy.sh probe          # expect 200 today if production matches the snapshots
./deploy.sh                # applies, restarts, prints before/after and the rollback command
```

Afterwards: a staff login and the CRM still work; an owner upload link still uploads.

## Follow-ups

1. Sign owner-facing tokens with their own secret (e.g. `OWNER_UPLOAD_SECRET`) instead of `JWT_SECRET`; needs the production `routes/ownerUpload.js`.
2. `GET /owners/:id` returns `automation.states[].chat_id` (effectively the phone number), bypassing masking and the reveal limit.
3. Older slice deploy scripts copy `routes/crm.js` only when production still has their recorded base md5. After this fix the md5 changes, so they abort instead of re-opening the hole. Rebase any future slice that ships `crm.js` on the patched file.
