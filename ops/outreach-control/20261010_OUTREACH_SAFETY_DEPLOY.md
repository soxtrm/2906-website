# Outreach safety deploy — 2026-10-10

Production host: `178.104.162.193`

Rollback snapshot: `/opt/2906-system/backups/outreach-20261010-123038`

The deploy applies `20261010_outreach_account_health.sql` and the exact source
delta in `20261010_outreach_safety.patch`. It adds persistent account
restriction state and history, a 40-hour default hold, recent-run volume
snapshots, draft-only pool previews, and ARM-time contact reservation.

Post-deploy checks:

- backend container: running
- backend HTTP listener: port 3001
- unarmed plans with active reservations: 0
- armed plans started by this deploy: 0
- restricted unhealthy outreach sessions: 4
- no outreach run was triggered

Deployed SHA-256:

```text
bc946f9764e632ff627341a5e86d80b8ee55e4200d82ae5871e4771832c8cb40  services/outreachPlanner.js
9312ef3775f3659a29d05963ef85bb4c0bebcdc93038b0ab28db7c487ab598d6  services/listBuilder.js
815ef738aac9f99a9e56c3d0c291e00dd280eda50df6e03ba854e50a53861874  services/adminCommands.js
638335de2d13f4f38ae466fe0abf687af552a9dd7d56b686d74e18c3e1ac1edd  routes/crm.js
98cb298bd4b641438a937e62fde67c23096bce34c3bf0c39d0c9479bd6e828b4  migrations/20261010_outreach_account_health.sql
```
