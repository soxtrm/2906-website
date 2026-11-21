# Release lock (2026-11-21)

Claude is the release owner for the 2906 / NEXUS website project (`2906-website-6zbi`).

- `autoAssignCustomDomains` is **off**: no deployment (Git push to `main`, `vercel deploy --prod`) moves the live domains by itself.
- A release goes live only by `vercel alias set <deployment> <host>` per domain, with a compare-and-swap check of the deployment currently served.
- Check / re-enable: `node vercel_lock.cjs` (lock, prints which deployment serves each domain) / `node vercel_lock.cjs unlock`.
- Audit: `node vercel_audit.cjs` lists every deployment with source (cli/git), branch, commit and dirty flag.
- Codex rules on this PC: `C:\Users\kevin\.codex\AGENTS.md`, section "Release freeze for Codex".
