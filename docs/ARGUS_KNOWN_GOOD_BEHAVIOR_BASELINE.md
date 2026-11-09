# ARGUS known-good behaviour baseline — 2026-11-09

Recorded before the owner-intelligence recovery changes (branch `claude/argus-owner-intelligence-recovery-20261109`). Nothing was deployed; production was read only (md5 inventory, source copy, schema and account rows).

## Three-way state

| | Where | Identity |
|---|---|---|
| **C — production** | `root@178.104.162.193:/opt/2906-system/backend` (not a git repo) | Matches the `EXPECTED` md5 list in `ops/owner-intelligence/deploy.sh` for all 16 guarded files, e.g. `services/autoOwnerConversation.js 0134df18…`, `services/agentIdentityRegistry.js 5a1b64af…`, `services/conversationPolicy.js 0a6d683a…`, `routes/crm.js dcd5f9d6…`, `cron.js 4d54178f…` |
| **A — last proven local state** | `codex/argus-outreach-recovery-20261107` @ `a610faa` | Chain: `claude/owner-pipeline` dc1b2ce → Codex owner recovery f827123/98bfd10 → shared owner history f80594a → inventory guard 33876fa → outreach recovery a610faa. None of it is in production. |
| **B — this branch** | `a610faa` + `dbc3aeb` `72bf5ad` `7a1fbec` `72d957d` `c9a238e` | See the recovery report. |

Not in production (present only in A/B): `timeGreeting.js`, `ownerOptOut.js`, `ownerQuestionPlan.js`, `locationRequest.js`, `websitePublication.js`, `ownerAttribution.js`, `inventorySecurityGuard.js`, `conversationRecovery.js`, `automationStatus.js`, `responseDedup.js`, `sharedOwnerHistory.js`. Production `outreachPlanner.js` still shifts each auto day by **+16 min**; the mirror uses the founder's **+15 min**.

The "27/27" and "67/67" passes reported in October were local runs of A's predecessors. They never reached production. That explains part of the regression: the fixes for greeting periods, opt-out detection, the reply delay of 120–180 s and agent takeover exist in the repository, but the live bot never ran them.

## Production configuration read (2026-11-09)

- `ARGUS_AGENT_IDENTITIES_JSON` is unset. Affiliations come only from code.
- `whatsapp_accounts`:
  - Active and outreach-enabled: `Argus2–5`, `default`, `Kevsecond`, `kevthirdd` (persona `kev`), `Cedric` (`cedric`), `Gabriela` (`gabriela`).
  - `Argus1` and `Olga` are inactive or not outreach-enabled. `Jasmine` is inactive.
  - Eight Kevin sessions are therefore outreach-enabled at once.
- Containers: `2906_backend` up 13 h, `2906_waha` healthy (3 weeks), `2906_postgres` healthy, `argus-outreach-testdb` (isolated test DB) up 11 days. The connection state of each WAHA session was not queried.

## Test baseline (isolated test DB `argus-outreach-testdb`, WAHA stubbed)

| Suite | At `a610faa` as checked in | After test-infra fix `dbc3aeb` |
|---|---|---|
| owner-intelligence (`node --test test/*.test.js`) | 56/112 when run without the VPS DB. On the VPS DB 83/112: 13 `MODULE_NOT_FOUND ../logger`, 7 missing `global_contact_suppressions`, 9 caused by those | **112/112**: migrations 20261030…20261107 applied to the test DB; one stale expectation updated (`dnc` → `global_suppression`; both block) |
| outreach-automation | 37/43 | 37/43, the same 6 failures (see the regression doc) |

Protected behaviours with tests that must stay green:
- opt-out → do-not-contact plus global suppression across accounts;
- agent takeover / relay stand-down;
- inbound idempotency (same message id → one reply);
- unverified-email block;
- per-unit property status (multi-unit, historical rental, December-future);
- closed-chat reopen without property mutation;
- shared redacted owner history;
- inventory copy guard;
- greeting periods 05:00–11:59 / 12:00–17:59 / 18:00+;
- reminder auto-send only with Auto on.
