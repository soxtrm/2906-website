# Outreach pace persistence and deterministic auto timing — 2026-10-28

Frontend release commit: `706da94`

Vercel deployment: `6C46Ysb3vhh7dGi7a5KouDvAEjAz` (`success`)

Production backend: `/opt/2906-system/backend` on `178.104.162.193`

Rollback snapshot:
`/opt/2906-system/backups/outreach-pace-20261028-0256/outreachPlanner.js`

The frontend now keeps the pace field visibly in one of four states: unsaved,
saving, saved, or failed. A successful save uses the value returned by the
backend before showing the saved confirmation, and the account refresh keeps
the persisted value after reload.

Auto preparation now proposes each following day exactly 16 minutes after the
previous scheduled time. This remains one minute beyond the existing 24h15
account gate. The prepared Morning, Afternoon, or Evening time is displayed in
the day cards, release controls, and the final `AUTO SAVED` confirmation.

The production planner contained newer recovery and conversation-safety work
than the repository mirror. It was therefore not replaced. Only the three
daily-interval expressions were changed with
`20261028_exact_16min.patch`, preserving all other production changes.

Verification:

- production Next.js build completed successfully with webpack;
- static auto-prepare contract test passed;
- desktop/mobile browser integration test passed, including 72% persistence,
  saved feedback, exact +16-minute proposals, and responsive overflow;
- Vercel commit status is successful;
- the live `/crm/outreach` bundle contains the new pace and auto confirmation;
- production backend syntax check passed and `/health` returned OK after the
  controlled backend restart;
- no outreach run, ARM action, owner contact, or scheduler was triggered.

Backend hashes:

```text
before / rollback  5451ad17581e90ead26266ad289533ef9676cd2c8c2f13c97e93de2ad6e8548a
after              5b90efeb325a0ae286c54adbcf2e7bed0c0c858b977bea12d145a4ff60636667
```
