# ARGUS Release Manifest

Deployed means running in production, not committed locally.

## 2026-11-09 — Property Source Sync (Integrations → Property Sources)

| | Value |
|---|---|
| Frontend | `crm.2906.estate/property-sources`, Vercel production from `main` at `481209e` (fast-forward from `4237eed`) |
| Backend | `/opt/2906-system/backend` on 178.104.162.193, container `2906_backend`, restarted 2026-11-09 22:37 UTC |
| Backend files | `index.js` bc53d588…, `cron.js` e4273168…, `routes/crmPropertySources.js` 8d49f4cb…, `services/propertySourceSync.js` 55de0b9f… |
| Migration | `20261109_property_source_sync.sql` (additive: 3 tables, 8 columns, 2 CHECK supersets, 2 disabled source registrations). 130 existing `website_source_inventory` rows unchanged |
| Backup / rollback | `/opt/2906-system/backups/property-source-sync-20261109T223707Z/`: previous `index.js`, `cron.js`, `routes/crmBaseInventory.js`, table dump, migration + down migration. The rollback command is printed by `ops/property-source-sync/deploy.sh` |
| Source code | `ops/property-source-sync/backend` (production mirror), `app/crm/property-sources/page.tsx` |

### Verified

- Backend tests: 60/60 on an isolated Postgres (production schema, no production data).
  - Adapter and SSRF: 28.
  - Workflow: 26, including the prototype's diff/review tests 17–31.
  - HTTP routes: 6.
- Prototype tests: 31/31.
- Browser test (Chromium, mocked API) at 360, 390 and 1440 px: `tests/property-sources.test.cjs`. Screenshots: `ops/property-source-sync/evidence/local/`.
- `next build` passes.
- Production API, with an admin token minted server-side and a 5-minute expiry:

  | Check | Result |
  |---|---|
  | Summary | 200 |
  | Events | 200 (0) |
  | Scan without permission | 403 |
  | Enable without permission | 403 |
  | `127.0.0.1` URL | 400 |
  | Unknown proposal | 404 |
  | Non-admin | 403 |
  | Unauthenticated (backend and live proxy) | 401 |

### Active vs disabled

- **Active:**
  - Registry and source management.
  - Rights record.
  - Interval setting.
  - Review queue (accept as unpublished staged draft / link / reject with reason / clarify / acknowledge).
  - Counts and in-app digest.
  - Scheduler tick (hourly; only acts on permitted, enabled, due sources).
- **Disabled:** live polling of My Next Home (`read_permission = NOT_RECORDED`). The dashboard shows "Connector disabled". No request is sent to the provider, and photos stay link-only until licensed.
- **Never:** WhatsApp or other messages, public listings, reposts.

### Remaining

- Provider written permission must be recorded in Rights before any scan.
- Detail-page selectors were built from documented structure and representative HTML, not live HTML. Verify them on the first permitted scan; an empty or failed scan is reported and never marks anything missing.
