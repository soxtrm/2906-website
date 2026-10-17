# Why repairs were reported as done while production stayed broken

Evidence only. Every line below is backed by a file, log line, DB row or command output collected on 2026-10-17. Nothing here describes Codex's internal reasoning.

## 1. The "46/46" approval repair was never committed or deployed (cause C)

| Evidence | Source |
| --- | --- |
| Report header: `Production state: not deployed; no live WhatsApp messages sent` and `Applied to production: no` | `link-mobile-cards/ARGUS_REPAIR_REPORT.md` (2026-10-16 20:01) |
| The repaired files (`outreachApproval.js`, `outreachApprovalState.js`, `wahaContactResolver.js`, `outreachAccounting.js`, migration `20261016_argus_system_repair.sql`) exist only as **untracked** `?? ops/outreach-control/backend/` | `git status` in `link-mobile-cards` |
| That worktree's HEAD is `d54f3cf` of 2026-10-10 with 158 dirty/untracked paths | `git log -1`, `git status --short \| wc -l` |
| None of those files is on `origin/main` | `git ls-tree origin/main` |
| Production DB has no approval table (only `outreach_runs`, `outreach_run_recipients`, `reminders`) | `information_schema.tables` on prod |

**Consequence:** the operator was told the approval was fixed; production ran the 2026-10-16 11:05 `adminCommands.js` unchanged.

## 2. The repair would not have fixed the observed failure (cause A + B)

| Evidence | Source |
| --- | --- |
| Codex's `adminCommands.js` keeps the time-only echo filter `if (state.setAt && Date.now() - state.setAt < 4000)` that swallowed the operator's "Yes" 2 s after the preview | `link-mobile-cards/ops/outreach-control/backend/services/adminCommands.js:1517` |
| Production log: `Yes` at 15:07:12 and 15:07:14 produced no reply; `Yes` at 15:07:19 was accepted | `docker logs 2906_backend`, dispatch lines 36325-36329 |
| The 46 tests ran with `CRM_TOKEN` absent; the report itself lists real-data suites as "not verified" | `ARGUS_REPAIR_REPORT.md` lines 131-160 |

## 3. The production backend has no source control (cause D/I)

| Evidence | Source |
| --- | --- |
| `/opt/2906-system/backend` is not a git repository (`git log` → "no git") | prod shell |
| 934 `*.bak*` files next to live code (`waha.js.bak.*` ×24, `worker.js.bak.*` ×15, …) — patches are applied by copying files, each agent with its own naming | `find -name '*.bak*'` |
| Local `2906-system` copy is also not a git repo and is from ~2026-09-23 | local shell |
| The repo `soxtrm/2906-website` only contains partial mirrors of backend files under several `ops/*` folders (`outreach-control`, `owner-group-flow`, `gptupload-flow`, now `outreach-approval-fix`) | repo tree |

**Consequence:** there is no single place where "the running backend" is defined. Any agent can overwrite any other agent's file on the VPS; a fix in a mirror folder is invisible to the next agent unless it reads that folder.

## 4. One Codex session has been running for three weeks

| Evidence | Source |
| --- | --- |
| `rollout-2026-09-25T15-39-43…jsonl`: 1.9 GB, 131 663 events, still written at 18:29 on 2026-10-17 | `~/.codex/sessions` |
| 217 context compactions, 268 aborted/interrupted turns, 28 approval waits in that one session | `rg -c` over the session file |
| Working directories within the same session: `link-mobile-cards` (4 919 events), `Desktop\NExususu` (6 878), `board-mobile-release`, `st-pauls-release`, … | `cwd` fields |

**Consequence:** decisions and file locations from earlier in the session survive only as compaction summaries; work is spread across worktrees whose state is not consolidated (e.g. the untracked repair above).

## 5. Parallel agents edit the same areas without coordination

- 26 git worktrees exist; Codex and Claude both changed `components/crm/board-dialogs.tsx`, `lib/crm/ui.tsx` and the mobile island on 2026-10-12/13 in different worktrees (`schedule-board-mobile-ux`, Codex on `main`).
- Name collision now: Codex's untracked `services/outreachApproval.js` and the deployed Claude `services/outreachApproval.js` (2026-10-17 16:28) have **the same path and different contents**. Deploying Codex's folder as-is would overwrite the live fix.

## 6. A 44-day-old agent loop was still running on the VPS

`bash -c 'until docker exec 2906_backend node -e require("/app/services/clientAssistant.js"); do sleep 1; done'`, parent PID 1, elapsed 3 809 399 s. The `require` never succeeds (module throws), so the loop spawned a Node process in the backend container every second for 44 days. **Stopped 2026-10-17** (PIDs 2695065, 3827124, 3827147); 0 remaining.

## 7. Not supported by evidence

- **15-minute job interference (E):** `nexus-google-traffic.timer` runs `/usr/bin/node /opt/nexus-routing/google-traffic-scan.cjs` on the host, outside Docker; backend `RestartCount=0` since 2026-10-16 11:11; no event of that job in the 15:06-16:00 window. Not reproduced → not a cause.
- **Self-chat / quoted handling (F):** the operator's self-chat "Yes" events reached `adminCommands` (`[dispatch] actionable … trigger:adminCommands body:"Yes"`). Routing worked; the handler swallowed/ignored them.

## Fixes that follow from this

1. One canonical backend source (git) and a deploy that is reproducible from it — see `REPAIR_BACKLOG.md` T1.
2. A change is "done" only with: commit on `main`, deploy evidence (md5 on host = md5 in repo), and a live workflow check (`AGENTS.md`).
3. One bounded task per session; write `AI_HANDOFF.md` at the end instead of growing one session for weeks.
4. Before deploying any mirror folder, diff every file against production (the `deploy.sh` md5 guard pattern).
