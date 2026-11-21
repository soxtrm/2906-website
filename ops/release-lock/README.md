# Release lock and release credential (2026-11-21)

Claude is the release owner for the 2906 / NEXUS website project (`2906-website-6zbi`).

## What is enforced technically

| Control | State |
|---|---|
| `autoAssignCustomDomains` | **off**: no deployment (Git push, `vercel deploy --prod`) moves a live domain by itself. Go-live is only `vercel alias set` per host with a compare-and-swap check. |
| GitHub `soxtrm/2906-website` `main` | protected: pull request required, required status check `Vercel` (up to date), conversations resolved, **enforced for admins**, no force-push, no deletion. Direct pushes to `main` are rejected for every account. |
| Release credential | a dedicated Vercel token (`claude-release-2906`, team scope, 90-day expiry), DPAPI-encrypted in `C:\Users\kevin\.claude-release\` (no inheritance; kevin + SYSTEM only; explicit DENY for `CodexSandboxUsers`). |
| Shared Vercel CLI login | retired by `retire-shared-login.ps1` once the release token works (revokes it server side). |
| Codex sandbox | verified 2026-11-21 with `codex sandbox`: the sandbox accounts cannot read the Vercel login, the release token, `~/.ssh/id_ed25519` or the GitHub credential, and cannot write to `~/.claude`, `~/.codex`, the Startup folder or `ProgramData`. |
| Codex "Full access" | blocked by the enforced policy `codex-policy/requirements.toml` once Kev installs it as administrator (`install-codex-policy.ps1`). |

## Commands

- Token: `powershell -File release-token.ps1 install | check`
- Vercel CLI with the release token (throw-away CLI config, never the shared login):
  `powershell -File release-token.ps1 vercel deploy --prod --skip-domain` / `... vercel alias set <dpl-url> <host>`
- Lock check / re-enable: `powershell -File release-token.ps1 run node vercel_lock.cjs [unlock]`
- Audit: `powershell -File release-token.ps1 run node vercel_audit.cjs`
- Retire the shared login: `powershell -File retire-shared-login.ps1 [-DryRun]`

## Known limits (same Windows account)

Claude and an unsandboxed Codex both run as Windows user `kevin`. Anything that runs outside the Codex
sandbox (a command Kev approves, the Codex computer-use / browser plugins driving Kev's desktop or Chrome)
has Kev's rights, including the shared root SSH key for the VPS. A hard boundary needs a separate Windows
account for Codex (Kev) and separate SSH keys per agent.

Codex rules on this PC: `C:\Users\kevin\.codex\AGENTS.md`, section "Release freeze for Codex".
