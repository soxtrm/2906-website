# AGENTS.md — rules for every coding agent (Codex, Claude, humans)

Short on purpose. Read this, then the module docs your task names.

## Where things are
- **Frontend + CRM + public site:** this repo (`soxtrm/2906-website`, Next.js). Deployed to Vercel from `main`.
- **Backend (WhatsApp bot, workers, APIs):** runs on the VPS at `/opt/2906-system/backend` in container `2906_backend` (code mounted, restart = `docker restart 2906_backend`). **It is not under git.** Backend files in this repo live in mirror folders under `ops/*/backend/` — each is a partial copy, not the whole backend.
- **Postgres** `2906_postgres`, **Redis** `2906_redis`, **WAHA (GOWS)** `2906_waha`. Host timers: `nexus-google-traffic.timer` (15 min), `nexus-routing-warm.timer`.
- Evidence of the current state: `ARGUS_FLOW_TEST_MATRIX.md`, `ARGUS_CODEX_FAILURE_DIAGNOSIS.md`, `AI_HANDOFF.md`.

## Before you edit
1. Know your target: which running file does this change? `md5sum` it on the VPS and compare with your copy. If they differ, rebase your change onto the production file first.
2. One task, one branch/worktree. Do not edit files another active task owns (check `AI_HANDOFF.md` → "In flight").
3. Reproduce the bug first (log line, DB row, or failing test that uses the real handler).

## While you work
- Repair, don't rewrite. Keep working behaviour; keep comments explaining *why*.
- Never send WhatsApp messages to real owners/clients while testing. Live tests use only an authorised test number (currently 35699811819) and one recipient.
- No production DB migration, deploy or bulk send without the operator's explicit OK in chat.

## Definition of done (all required)
1. Committed on a branch and pushed; mirror folder updated.
2. Tests that drive the **real** handler pass, and the same tests fail on the old code.
3. Deployed with a backup and an md5 guard (see `ops/outreach-approval-fix/deploy.sh`), md5 on VPS = md5 in repo.
4. The workflow was exercised end-to-end (log lines / DB rows / provider ack quoted in the handoff).
5. `AI_HANDOFF.md` updated: what changed, commit, tests run, what is NOT verified.

"Build passes" or "N/N unit tests" alone is never "done". Write NOT TESTED / BLOCKED when you could not verify.

## Handoff format (append to AI_HANDOFF.md)
```
### <date> <task>
Changed: <files> (commit <sha>, branch <name>)
Why: <root cause with evidence>
Tests: <command> → <result>; live: <what was exercised>
Deployed: yes (<backup path>, md5 <x>) | no (why)
Not verified / risks: <list>
Next: <one bounded task>
```

## Never
- Long-running sessions that span weeks and many worktrees — finish a task, write the handoff, start fresh.
- Leaving fixes untracked in a worktree.
- Two files with the same path and different content in different mirror folders (e.g. `services/outreachApproval.js`).
- Background loops on the VPS (`until … do sleep`) left running after your task.
