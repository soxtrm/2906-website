# ARGUS × NEXUS integration-gate staging

Approved by Kev on 2026-11-12. Hosted on the existing VPS as a fully separate Docker Compose project. **Production was not modified, migrated, restarted or redeployed**; the gate script checks that before and after every run.

## Gate result (2026-11-12, hosted staging)

**12/12 gate steps passed, 8/8 isolation checks passed, production unchanged.**

Pinned revisions (committed code only, exported with `git archive`):

| System | Commit | Branch |
|---|---|---|
| ARGUS owner link | `df5048d` | `claude/argus-nexus-owner-link-20261111` |
| NEXUS | `4c6d44f` | `codex/nexus-argus-signed-reads-20261112` |
| ARGUS production files reused unmodified | `db.js` md5 `c9712948…`, `services/boardAction.js` md5 `21b3978b…` | checksum-verified against the live backend at build time |

| # | Gate step | Result |
|---|---|---|
| 1 | ARGUS owner → invitation → NEXUS activation; a pending owner sees nothing | Pass |
| 2 | Owner verification → property linking; acknowledgement applied; canonical ids reported back; never "synced" before that | Pass |
| 3 | Distribution authorisation from NEXUS applied in ARGUS; unknown channel or scope never leaves NEXUS | Pass |
| 4 | Availability: one timestamp (`properties.last_confirmed_available_at`), shown identically by NEXUS; duplicates and holds do not move it | Pass |
| 5 | Passport update in NEXUS → persisted in ARGUS for review → signed acknowledgement; ARGUS listing not overwritten; private description not sent | Pass |
| 6 | Authorised listing synchronisation ARGUS → NEXUS: applied, then (and only then) reported as synced | Pass |
| 7 | Marketplace visibility: own agency yes; another agency only after an authorised immediate release and only if named; unverified professional refused | Pass |
| 8 | Delayed release (7 days from approval): nothing visible before; visible after (one route's clock shifted in the staging database) | Pass |
| 9 | On-market and stale filtering: off-market listing leaves discovery; a 6-day-old confirmation is shown as overdue, excluded from "recently confirmed", flagged not consumer-discoverable, status unchanged | Pass |
| 10 | Failed deliveries stay pending and retry safely, both directions, with the services actually stopped | Pass |
| 11 | Unsigned, wrong-secret, wrong-key and other-tenant requests rejected on both receivers; replay returns the stored answer; changed replay refused; another account cannot act | Pass |
| 12 | Owner revocation stops sharing in ARGUS, NEXUS and discovery; replayed older update cannot revive it; agency can take a release back | Pass |

Isolation checks: NEXUS has no ARGUS database login configured; its legacy local reads are off; it is not on the ARGUS database network and cannot open a connection to that database; ARGUS staging is on no production or NEXUS database network; neither staging service holds messaging, queue or payment configuration; no port is published beyond the VPS loopback.

The first hosted run was 11/12: step 10 failed on a wrong expectation in the test driver (two listings had changed, the driver expected one failed event). The systems behaved correctly; the driver was corrected (`df5048d`) and the whole gate re-run.

### Regression suites (run locally, same pinned code)

| Suite | Result |
|---|---|
| ARGUS owner-link backend (`ownerLink`, `routes`, `distributionRouting`, `schedulerDefaults`, `ownerPush`) | 46/46 |
| Cross-system, local, NEXUS `4c6d44f` with no ARGUS database login | 9/9 steps |
| ARGUS Property Source Sync (`ops/property-source-sync/backend/test`), production schema, no production rows | 60/60 |
| NEXUS `tests.test_nexus_housing` on `4c6d44f` | 7/7 |
| NEXUS `tests.test_nexus_identity` on `4c6d44f` | 16/17 — `test_booking_prefill_only_returns_own_permitted_account_fields` errors (non-JSON reply); Codex reports the same error before these changes |
| ARGUS Client Sync | **No automated suite exists** in the repository. Its code is not part of this branch and is not present on staging. Not verified by a test. |
| ARGUS owner-profile UI (browser, 3 viewports) | Last run 2026-11-11, 3/3; UI unchanged since |
| NEXUS Booking / Marketplace regressions | Not run here (Codex reports unchanged results against its baseline, with pre-existing failures) |

## Architecture

```
VPS (existing, 4 vCPU / 8 GB)                    compose project: argus-nexus-staging
  127.0.0.1:8443 ── proxy (Caddy, own internal CA, TLS)
                      ├── argus.staging.test → argus  (owner-link routers only) ── argus_db net ── argus_pg
                      └── nexus.staging.test → nexus  (pinned NEXUS server)     ── nexus_db net ── nexus_pg
```

- **ARGUS staging is not the production backend.** It mounts the two owner-link routers and the link scheduler on two unmodified production files. The image contains no worker, cron, WAHA client, queue, notification or payment code, so it cannot contact an owner. It refuses to start against a database whose name is not a staging database.
- **Databases:** two separate PostgreSQL 16 containers on two internal networks. ARGUS has the production *schema* (305 tables, taken structure-only) with zero production rows; data is synthetic (`STG-…` listings, invented owners with reserved test numbers).
- **Secrets:** generated on the VPS into `/opt/argus-nexus-staging/.env` (mode 600), different in each direction, never printed, never committed, unrelated to production. No production credential exists on staging.
- **HTTPS:** every call between the two services goes through the staging proxy with certificate verification against the staging CA.
- **Access:** nothing is reachable from the internet. Published port: `127.0.0.1:8443` only.
- **Limits and logs:** per-container memory, CPU and process limits; JSON logs capped at 3 × 10 MB per container; `no-new-privileges`.

### Resource usage (measured after the gate run)

| Container | Memory (limit) |
|---|---|
| argus | 23 MB (384 MB) |
| nexus | 20 MB (384 MB) |
| argus_pg | 46 MB (512 MB) |
| nexus_pg | 28 MB (512 MB) |
| proxy | 14 MB (128 MB) |

About 130 MB of memory in use, idle CPU near zero, about 135 MB of volumes and about 1.7 GB of images. The VPS had 5.6 GB of memory available and 81 GB of disk free.

**Cost: no additional recurring cost.** It runs on the existing VPS. No new server, domain, certificate or service was bought.

## Access (authorised developers and testers)

SSH access to the VPS is the gate: there is no public URL.

```bash
ssh -L 8443:127.0.0.1:8443 root@<vps>
```

Add to the tester's hosts file: `127.0.0.1 argus.staging.test nexus.staging.test`. Then:

- NEXUS Owner Portal: `https://nexus.staging.test:8443/housing/owner`
- NEXUS professional workspace: `https://nexus.staging.test:8443/housing/marketplace`
- ARGUS staging health: `https://argus.staging.test:8443/healthz`

The browser must trust the staging CA (`/opt/argus-nexus-staging/staging-root-ca.crt`, a public certificate) or the warning must be accepted. A staff session for the ARGUS staging API: `docker compose exec argus node staff-token.js <agentId>` (valid on staging only).

## Operating it

```bash
bash package.sh <bundle.tgz> <nexus repo> <nexus commit>   # locally: committed code only
bash setup.sh --with-nexus                                 # on the VPS, in /opt/argus-nexus-staging
docker compose exec argus node seed.js                     # synthetic data
bash gate.sh                                               # the gate, with before/after production check
bash teardown.sh [--purge]                                 # remove staging (optionally with its data)
```

## Known limits of this gate

- **Not internet-facing.** "Hosted" means running as services on the VPS over HTTPS; testers reach it by SSH tunnel. A public staging hostname would need a DNS record and a change to the production proxy, which was not approved.
- **ARGUS staging serves the owner-link surface only.** The rest of ARGUS (CRM pages, Property Sync, Client Sync, outreach) is deliberately absent, so their behaviour on staging is not covered here.
- **The owner-profile NEXUS tab (Next.js UI) is not deployed on staging.** Staff actions in the gate use the same staff API the UI calls.
- **Delayed release** was proven by shifting one route's timestamps in the staging database, not by waiting seven days.
- **Tenant isolation** was tested as: another agency key is refused on both receivers, and a professional of another agency sees only what was released to it. A second ARGUS tenant (Benestates) was not stood up.
- **Consumer discovery** does not exist in NEXUS yet; the stale rule was checked on the professional view and on the ARGUS flag.

## Separate deliverables, not part of this gate

Structured owner Q&A (ARGUS receiver exists; NEXUS has none) · customer-to-ARGUS viewing appointment round trip · staff accept/reject of owner edits · ARGUS Light in NEXUS STUDIOS as a product (its discovery API was used by the gate; its screens were not tested) · further Marketplace modules.

## Readiness

The integration is proven on hosted staging for the scope above, with both sides on committed revisions. It is **ready for a production rollout plan to be reviewed, not for production itself**: before that, the items in "Known limits" that matter to you should be decided, the ARGUS deploy script should be dry-run reviewed (it adds tables and two mounts; with no NEXUS settings it enables no traffic), and NEXUS needs its own production configuration. No merge and no production deployment without your separate approval.
