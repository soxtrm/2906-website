# Development storage hygiene (NEXUS / 2906, Windows dev computer)

Three scripts for `D:\2906` and the Claude/Codex/Playwright folders. They work in Windows
PowerShell 5.1 and PowerShell 7, never follow junctions or symlinks, and never touch
production servers.

| Script | Changes anything? | Purpose |
|---|---|---|
| `dev-audit.ps1` | **No** (also no Git index refresh) | Report: free space, 20 largest folders and files with the reason each exists, regenerable space, every checkout/worktree with uncommitted/unpushed/stash counts, protected files |
| `dev-clean.ps1` | Only with `-Apply` (dry run by default) | Removes regenerable files by category, logs every deletion with its size, shows free space before/after |
| `install-schedule.ps1` | Registers one scheduled task | Weekly safe cleanup (caches, old test output, old agent temp) |

Default roots: `D:\2906`, `%USERPROFILE%\.claude`, `%USERPROFILE%\.codex`,
`%LOCALAPPDATA%\Temp\claude`, `%LOCALAPPDATA%\ms-playwright`, `%LOCALAPPDATA%\npm-cache`.
Reports and logs go to `D:\2906\_hygiene\` (the newest 20 of each are kept).

```powershell
cd D:\2906\<checkout>\ops\dev-hygiene
powershell -NoProfile -ExecutionPolicy Bypass -File .\dev-audit.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\dev-clean.ps1            # dry run
powershell -NoProfile -ExecutionPolicy Bypass -File .\dev-clean.ps1 -Apply     # caches, tests, temp
```

## Classes used in the audit

| Class | Examples | Treatment |
|---|---|---|
| **Safe** (regenerable) | `node_modules`, `.next`, `.turbo`, `coverage`, `test-results`, `playwright-report`, Claude session temp, npm cache | `dev-clean.ps1` categories |
| **Verify** | clean and pushed worktrees, `dist`/`build`/`out`, archives (`*.zip`), screenshots, `.claude\projects` transcripts, old Playwright browsers | decided by a person; worktrees only with `-RemoveWorktree <path>` |
| **Important** | source, `.git`, checkouts with changed/untracked/unpushed/stashed work | never touched |
| **Protected** | `.env*`, keys, `*.pem`, `*.sql`, `*.db`, `*.dump`, anything named backup/secret/credential, `.ssh` | never touched, listed by path only |

## What dev-clean.ps1 deletes

| Category | Rule | Default |
|---|---|---|
| `caches` | `.next .turbo .vite .parcel-cache __pycache__ .pytest_cache .mypy_cache .ruff_cache coverage .nyc_output`, unchanged for 24 h | on |
| `tests` | `playwright-report test-results blob-report` older than 14 days | on |
| `temp` | `%LOCALAPPDATA%\Temp\claude\<project>\<session>` unchanged for 7 days | on |
| `logs` | `*.log` unchanged for 30 days | opt-in |
| `shots` | media in `shots/screenshots/traces/videos` folders beyond the newest 20 and older than 14 days | opt-in |
| `deps` | `node_modules` of checkouts with a clean status, no stash and no commit for 14 days | opt-in (next use needs `npm ci`) |
| worktree | `-RemoveWorktree <path>`: only linked worktrees that are clean, stash-free, have an upstream and nothing unpushed; `git worktree remove` + `prune`; the branch stays on GitHub | explicit only |

Always: only inside the roots, never a root itself; inside a Git checkout only what
`git check-ignore` reports as ignored (a tracked folder named `coverage` stays); never a protected
name; never a folder that contains a protected-looking file; the hygiene reports themselves are kept.

## Routine (Claude, Codex and people)

1. **Reuse workspaces.** One long-lived checkout per repository (`D:\2906\<repo>`). Before
   creating a new checkout or worktree, check whether an existing one fits: run
   `git worktree list`, or read the checkout table in the latest audit.
2. **Worktrees are temporary.** Create them under `D:\2906\_wt\<repo>-<topic>`. After the branch is
   merged or pushed and no longer needed:
   `dev-clean.ps1 -RemoveWorktree D:\2906\_wt\<name> -Apply`. The script refuses unpushed or dirty ones.
3. **One dependency install per checkout.** Use `npm ci` in the checkout you work in. Do not copy
   projects with their `node_modules`. Do not install into scratch copies. Delete inactive
   checkouts' `node_modules` with `-Categories deps`.
4. **Build archives** (`git archive`, `*.zip`/`*.tgz` bundles) go to the system temp folder and are
   deleted after the upload. Keep only the archives a documented rollback needs, in
   `D:\2906\_releases\<project>\` (latest 3).
5. **Test output.** Playwright: `trace: 'retain-on-failure'`, `screenshot: 'only-on-failure'`,
   `video: 'off'`; write ad-hoc screenshots to the session scratchpad, not into the repository.
   Evidence that a report references belongs in `docs/evidence/...` and is committed. Everything
   else expires after 14 days.
6. **Logs.** Long-running dev servers log to a file in the session scratchpad, not the repository.
   Logs over 100 MB are rotated: restart the process with a new file. Logs expire after 30 days
   (`-Categories logs`).
7. **Claude Code transcripts** (`%USERPROFILE%\.claude\projects`) are pruned by Claude Code
   itself after `cleanupPeriodDays` (default 30) in `%USERPROFILE%\.claude\settings.json`.
   Lower the value only if the audit shows it is large.
8. **Weekly**: the scheduled task cleans caches, old test output and old agent temp. **Monthly**:
   run the audit and review the *Verify* list.

## Never

- delete a whole project folder because it looks like a duplicate: compare Git remotes and
  status first (the audit lists both);
- delete anything under a production server, `*-backups`, `.env*`, databases or dumps;
- run `dev-clean.ps1 -Apply` with `deps` while a dev server of that checkout is running.
