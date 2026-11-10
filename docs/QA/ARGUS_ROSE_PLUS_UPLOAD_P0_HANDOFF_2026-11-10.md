# ARGUS Rose + Plus Upload P0 — production handoff

Status: **DEPLOYED WITH ONE EXTERNAL BLOCKER**  
Production verification: 2026-11-10 15:26 Europe/Malta  
Branch: `codex/argus-rose-plus-p0-20261110`

## Root causes

### Rose / property 2906-069

The live conversation was flattened from a partially occupied shared flat into a whole-property `RENTED` event. The availability handler then committed `available_status=rented`, `operational_status=RENTED`, unpublished the property and sent a false completion claim saying the property had been removed. The existing sharing-price extraction retained EUR 800 but did not preserve the separate EUR 1,600 whole-flat total or the single available roommate place.

### Plus Upload

The two real seven-image runs retained their originals but the image provider returned HTTP 402 because the AI Studio prepayment credits were depleted. The existing synchronous processor recorded a generic failed run after the provider circuit opened; item progress, ownership and failure classification were not durable enough, and the initial `0 / 7 complete` message could be read as active progress. No generated asset existed, so the pipeline correctly had nothing high-quality to save.

## Corrections

- Added multidimensional shared-accommodation parsing: occupancy, whole-property availability, place/room counts, per-person price, total rent, availability date and viewing invitation.
- Partial occupancy can no longer become a whole-property `RENTED` mutation.
- The Rose incident now produces an approval-required owner review task and a concise founder-approved corrective draft; it does not auto-send or auto-republish.
- Added fact provenance and review persistence required by the existing Owner AI Recovery.
- Added global opt-out dependencies and the additive suppression/privacy schema needed by the integrated recovery code.
- Added durable upload batch/item states, expected/completed/failed counters, heartbeat fields, ownership scope, stable item IDs, original URLs, explicit provider failure codes and a stalled-run recovery function.
- `!plusupload` and `!gptupload` remain distinct. Originals are never reported as enhanced output.
- The upload handler was merged onto the current live handler instead of overwriting its newer source-sync behavior.

## Production before / after

| Field | Before | After |
|---|---|---|
| Property | `2906-069` | `2906-069` |
| Availability | `rented` | `pending_check` |
| Operational status | `RENTED` | `NEEDS_HUMAN_REVIEW` |
| Published | false | false; no blind republish |
| Occupancy | not represented | `PARTIALLY_OCCUPIED` |
| Whole flat available | not represented | false |
| Available offer | lost | 1 place |
| Occupied people | not represented | 1 |
| Price | EUR 800 sharing price plus stale EUR 1,800 listing price | EUR 800/person and EUR 1,600 total recorded separately |
| Viewing | not represented | invitation recorded; no appointment invented |
| Corrective reply | false removal claim had already been sent | review draft only; 0 messages sent by recovery |

Live evidence confirms one `DECISION_REQUIRED / REVIEW_SHARED_PLACE` task, seven sourced Rose facts, one recovery audit activity and zero outbound messages after recovery.

## Seven uploaded items

The real PLUS batch is `ee558cb9-157f-4d7e-9a3d-06b3ba6515dc`:

- preset: `premium`
- expected: 7
- completed: 0
- failed/retryable: 7
- persisted phase: `BLOCKED_PROVIDER`
- failure code: `PROVIDER_BILLING_BLOCKED`
- originals retained: 7/7
- enhanced outputs: 0/7
- duplicate property/gallery writes: none observed

A separate conservative seven-image batch, `4b0f3e84-ac59-4b31-933c-751dd1f7c9e8`, has the same external billing block and retained all seven originals. No retry was issued because that would repeat a paid-provider failure and the user did not authorize new provider spend.

## Tests

- new attachment regression pack: **48/48 passed** (R01-R28 and U01-U20)
- existing Owner AI golden matrix: **486/486 passed**
- numbered legacy cases 001-136 remain inside that authoritative 486-case matrix; no separate executable 136-test file exists in the repository, so no substitute result was invented
- conversation recovery contracts: **9/9 passed**
- upload pipeline and command contracts: **24/24 passed**
- Node syntax checks: passed locally, in staging on the host and on the installed production files
- production DB verification: passed for Rose facts/task/audit/no-send and all seven PLUS items
- internal backend health: HTTP 200 with `ok:true`; PostgreSQL and WAHA containers healthy

Browser reachability was checked at 390x844 and 1440x1000. The protected CRM correctly redirected to login and returned 401 for `/api/crm/me`; therefore the authenticated Rose task screen could not be captured without using or exposing user credentials. The two reachability captures are under `docs/QA/evidence/2026-11-10/`.

## Commits and deployment

- `ffe0459` — shared-place recovery, upload batch state, 48 regressions and QA contracts
- `087382f` — live-schema hardening, guarded recovery SQL and browser evidence
- remote branch pushed: `origin/codex/argus-rose-plus-p0-20261110`
- production code backup: `/opt/2906-system/backups/argus-rose-plus-p0-20261110T151250Z`
- backup includes code checksums and a 138 MB PostgreSQL custom-format dump

Installed production SHA-256 values:

- availability: `d72cd4b42358281acfcd81477bf2c27783744e7c389b203d36d10a891d6c52cd`
- conversation policy: `bf9976f32b23c00554fb5e8e7b11ad256d365a6a6d7300c6b97c703b52e93e83`
- conversation intelligence: `7fb4e3fe63c2892dbbc260e7f9c7e414c5b5dcc989948c943ea3668d6629dd4c`
- shared accommodation: `4d9cebdbf0bb7f3cc3784ac8cb2b751296627786316e2e0862c55b713f3dd056`
- photo pipeline: `038cf64377f7b86d12cf4c6e67aacd719bcca64cc2c582dbe9cc171f33f3d522`
- merged live upload handler: `c9c859b8e22f498b8c7ab2cdaff7610b4538f4a4699cec8b8d7e443321cbdc86`

## Remaining limitations / required action

1. **BLOCKED — image generation:** restore the existing AI Studio provider credits. Then an administrator may explicitly retry the retained PLUS batch. Until then, 0/7 is the truthful result and no high-quality generated assets exist.
2. **PARTIAL — crash automation:** batch/item persistence and `recoverStalledRuns()` are deployed, but the existing pipeline is still synchronous and no new independent recurring recovery worker was introduced in this P0. A manual retry remains available after the provider is restored.
3. **REVIEW REQUIRED — Rose reply:** the corrective message is intentionally unsent. An authorized administrator must review/approve it.
4. **Browser evidence boundary:** authenticated task/gallery screenshots require an existing authorized login session; credentials were not requested, read or exposed.

No test WhatsApp message, provider retry, public publication or blind property reactivation was performed.
