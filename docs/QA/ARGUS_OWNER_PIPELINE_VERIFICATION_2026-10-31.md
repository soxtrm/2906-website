# ARGUS owner pipeline — verification (2026-10-31)

Branch `claude/owner-pipeline` (on top of `claude/owner-intelligence-main`). Nothing deployed, nothing sent, nothing published.

## Environments
- **Isolated test DB:**
  - docker network `argus-outreach-testnet` (`--internal`), container `argus-outreach-testdb`
  - production schema, no production data
  - all migrations run up/down/up/idempotent
- **Unit/integration tests:** real backend modules from `ops/owner-intelligence/backend` against that DB, with stubbed WAHA/queues/Telegram. Run with:

  ```
  docker run --rm --network argus-outreach-testnet -v <mirror>:/work -w /work -e NODE_PATH=/app/node_modules -e TZ=UTC --entrypoint node 2906-system-backend --test test/<file>
  ```
- **Production-copy integration:**
  - the whole production backend code copied on the VPS to `/tmp/full-backend`, with production `node_modules` mounted **read-only**
  - pointed at the test DB, no WAHA, no Redis
  - existing proofs compared before and after with the mirror files overlaid

## Results
| Suite | Result |
|---|---|
| timeGreeting (11:00/12:00/17:00/18:30, Fri/Mon/Sun, night, DST, queued draft) | 8/8 |
| ownerIdentity (answer once, emails, duplicate webhook) | 5/5 |
| locationRequest | 7/7 |
| agentChat (relay stand-down) | 5/5 |
| ownerReminder | 4/4 |
| websitePublication (publish once, no duplicate, edits, rented, unpublish, not-ready, failure → failed → retry, in-flight change, reconcile) | 8/8 |
| ownerAttribution (Cedric session, two agents, reply needed, no fake activity, UNKNOWN, bound agent, audited reassignment, chat-start trigger) | 8/8 |
| ownerQuestionPlan (address/floor, garage/subletting, pets ≠ subletting, winter let) | 9/9 |
| scorecardFacts (provenance, newest wins, multi-unit not bound) | 3/3 |
| **Total** | **57/57** |
| Production-copy proofs (`staged-questions-proof`, `owner-conversation-catalog-proof`, `ownerAi.repair.test`) | identical before/after (their flow parts fail in both runs: they need live WAHA/Redis) |
| Frontend `tsc --noEmit` | clean |

## Acceptance tests from the brief
| Test | Status |
|---|---|
| Cedric session → "Contacted by Cedric"; Olga/Kevin not mislabelled | ✔ test |
| Two agents → both histories, initiator kept, conflict flagged | ✔ test |
| Reply needed visible, no fake active | ✔ test |
| Search owner → agent, account, properties, history on one screen | backend ✔, UI not rendered |
| Winter Let + explicit date on the scorecard; unknown stays unknown | ✔ test |
| Address known → only floor; floor known → only address; garage known → only subletting; pets ≠ subletting | ✔ test |
| 10-unit owner: no blended listing | partial: facts bind only to an unambiguous unit (test); a photo/address "which apartment?" prompt was not built |
| 11:00 → Good morning; draft from the night before → send-time greeting | ✔ test |
| Publish once, repeated event no duplicate, edits update, rented → not available, failure visible + retry | ✔ test |
| Tenant isolation / no cross-agency leakage | not changed: publication only on `properties.published`; owner list keeps the existing masked visibility |
| No regression of search / matching / outreach / sessions / public cards | partial: proofs identical; no browser run |

## Not verified
- No browser run of the new owner list, owner page, property page or board chips.
- No live WhatsApp message, no live publication.
- Production-copy flow tests need WAHA/Redis.
- The production drift counts are a read-only snapshot from 2026-10-31.
