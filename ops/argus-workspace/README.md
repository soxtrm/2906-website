# ARGUS unified workspace backend

This directory is the reviewable source for the backend additions deployed to
the existing Node/Express service under `/opt/2906-system/backend`.

- `20261010_argus_workspace_index.sql` creates the role-safe shared property
  index, village centroids, query indexes and the separate derived-filter fact
  table.
- `backfillArgusWorkspace.js` fills village centroids and text-derived tenancy
  evidence without overwriting structured property facts.
- `crmWorkspace.js` provides `GET /api/crm/workspace/search` across property,
  person, masked owner and map/traffic coverage domains.
- `crmScheduleBoard.patch` moves all visible Schedule Board filters into the
  backend and uses village-level coordinates for board geometry filters.
- `index.patch` mounts the workspace route before the CRM catch-all.

The route keeps traffic provenance explicit: stored route models and historic
observations are returned as coverage with `live: false`. It does not treat
them as live traffic or taxi-price measurements.

The pre-route rollback copy for the first deployment is stored on the backend
host at `/opt/2906-system/backups/20261010-argus-workspace-pre-route`. The SQL
changes are additive; restoring the two backed-up JavaScript files disables
the new route and board integration without touching existing property facts.
