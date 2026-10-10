# Outreach auto-prepare deploy — 2026-10-11

Production host: `178.104.162.193`

Rollback snapshot: `/opt/2906-system/backups/outreach-auto-20261011-003711`

The deploy applies `20261011_outreach_auto_settings.sql`, replaces the tracked
production copy of `services/outreachPlanner.js`, and adds the route shown in
`20261011_crm_auto_prepare.patch`.

Behaviour:

- backend account cooldown is exactly 24h15;
- account auto-prepare persists one 16–22 minute daily drift and one base ±3
  contact count per untouched day;
- prepared contacts are previews only and do not reserve or advance the pool;
- ARM rechecks eligibility, refills to the stored target, locks atomically, and
  commits the pool cursor only after the queue job exists;
- the account base count and message remain stored across reloads.

Post-deploy checks:

- backend health endpoint: OK;
- schema columns present: 2/2;
- auto-prepare route without authentication: 401 (route is mounted and gated);
- armed plans before/after: 0 / 0;
- latest outreach batch id before/after: 248 / 248;
- active reservations on unarmed plans before/after: 0 / 0;
- no outreach run was triggered and no scheduler was added.

Deployed SHA-256:

```text
c7047db088fe0f10645e57725669ac2cb860af07182550f06ae35ba3a7a6fdb1  services/outreachPlanner.js
72fdd0b3ed012a1b2192363daf8d9ac5dd2578b53ec9c438b1ec104a5e5801d9  routes/crm.js
```
