# ARGUS ↔ NEXUS — compatibility report

2026-11-12 (night) · ARGUS branch `claude/argus-nexus-owner-link-20261111` against NEXUS commit **`9947028`** ("Honor strict ARGUS acknowledgements and push consented owner updates", branch `codex/nexus-argus-signed-reads-20261112`). Contract `2026-11-11.v1`, revision 2 ([CONTRACT.md](CONTRACT.md)).

**Result in one line:** every gate scenario that can be exercised locally passes between the two committed implementations. Still open: NEXUS `9947028` reads the ARGUS database directly, approved Q&A is not pushed, and no hosted staging run has happened. **The gate is not passed until it runs on hosted staging.**

Architecture reference: ARGUS is the real-estate operations and synchronisation backend; the Owner Portal and ARGUS Light are NEXUS STUDIOS surfaces built by Codex; nothing in this branch builds a NEXUS interface.

## How this was verified

`backend/test/crossSystemPush.test.js` starts the real ARGUS routers of this branch and the real NEXUS handler (`server.py` from a clean export of `9947028`), each on its own local throw-away PostgreSQL 16 database, and drives everything over HTTP with real signatures in both directions: the owner's actions through the NEXUS Owner Portal API with a real NEXUS account, staff actions through the ARGUS staff API. No stub receiver, no mocked signer, committed code only.

Limits: local loopback, not hosted staging; the https-only rule of the ARGUS sender is bridged by a test transport; NEXUS's owner push is behind its flag `NEXUS_HOUSING_ARGUS_OWNER_PUSH`, switched on for the run; NEXUS was given a login on the local ARGUS test database because `9947028` still needs one. No production data, no VPS, no hosted Supabase.

## Gate scenarios

| # | Scenario | Local, real code both sides | Hosted staging |
|---|---|---|---|
| 1 | Owner edits a property in NEXUS → ARGUS receives the updated data | **Pass.** ARGUS stores the edit for review with its version; only shareable facts are sent (the owner's private description is not); the ARGUS listing is not overwritten. A schedule change arrives once the owner shares the viewing schedule, and not before. | Not run |
| 2 | Owner confirms availability → ARGUS timestamp updates → NEXUS displays the confirmed value | **Pass.** `properties.last_confirmed_available_at` moves; NEXUS shows exactly that instant and keeps none of its own for the linked listing; a hold does not move it. | Not run |
| 3 | Owner changes distribution permissions → ARGUS applies them | **Pass.** Unknown channel, unknown scope and empty scope are refused before leaving NEXUS, and independently by ARGUS. | Not run |
| 4 | Owner revokes access → downstream sharing is stopped | **Pass.** Grants end, the gate closes, `property.withdrawn` is delivered, NEXUS marks the listing withdrawn, a replayed older update does not revive it. | Not run |
| 5 | Duplicate events do not create duplicate records | **Pass.** | Not run |
| 6 | Failed deliveries remain pending and retry safely | **Pass**, both directions. | Not run |
| 7 | Unauthorised events are rejected | **Pass**, both receivers and across NEXUS accounts. | Not run |
| 8 | Existing ARGUS and NEXUS workflows continue functioning | **Partly checked.** ARGUS listing rows untouched except the staff edit made by the test; no swipe-link rows; the outreach and messaging modules cannot be loaded by this code in any suite. Codex's housing suite ran 6/6 here on `a2068ab` and was not repeated on `9947028`. **Not re-run:** ARGUS Property Source Sync and outreach suites (VPS test container); NEXUS Booking and Marketplace regressions. | Not run |

No step in the test is marked as a gap any more.

## Open items against the decisions of 2026-11-12

| # | Decision | State at `9947028` | Who |
|---|---|---|---|
| 1 | No direct database access from NEXUS to ARGUS | Still present in the commit (`NEXUS_HOUSING_ARGUS_READ_DSN`). Codex has uncommitted work that calls `/read/owner-link`, `/read/properties`, `/read/viewing-busy` and `/read/source-match`; it is not verified here. ARGUS now also provides `/read/market` (agency-wide, fail closed) and the staff listing lookup by reference, which were the reads still missing. | NEXUS: finish the switch and commit; then the test runs without a database login for NEXUS. |
| 2 | Push approved owner Q&A | Not pushed. ARGUS receiver (`qa.answer_approved`, `qa.answer_withdrawn`) is built and tested with signed events. NEXUS has no structured Q&A yet. | NEXUS |
| 3 | Acknowledgement means validated and persisted | Met: NEXUS answers `applied: true` and lists the linked listings with canonical ids; ARGUS refuses to report "synced" otherwise. | — |
| 4 | One availability timestamp | Met for ARGUS-linked listings. NEXUS's own column remains only for its separately disabled preverified-pilot path. | Decide whether that pilot path stays. |
| 5 | Permission vocabulary aligned, mapped, tested, fail closed | Met (CONTRACT.md §4a). | — |
| 6 | Versioning, idempotency, retries, out-of-order, no feedback loop | Met and tested on both paths exercised here. | — |
| 7 | Owner push switched on | NEXUS keeps passport and schedule pushes behind `NEXUS_HOUSING_ARGUS_OWNER_PUSH` (off by default) and behind the owner's matching scope. | Set on staging. |

Smaller findings:

- **Retries on the NEXUS side are the owner's.** A push is synchronous; if ARGUS is down the owner sees an error and retries with the same command. Safe, but nothing is queued in NEXUS.
- **Listing references.** NEXUS accepts refs matching `[A-Za-z0-9][A-Za-z0-9_-]{0,79}`. Production refs were not checked against that pattern.
- **Viewing lengths.** Owner schedule 15/30/60 minutes; ARGUS appointments 10/20. ARGUS stores the schedule and creates no appointments from it. The viewing-request round trip (customer requests a viewing → ARGUS appointment) is not part of this contract yet.
- **Consumer staleness.** ARGUS exposes `consumerDiscoverable` (false after about five days without a confirmation, configurable). Acting on it in consumer discovery is a NEXUS decision; nothing consumes it yet.
- **Tenancy.** This ARGUS instance serves one agency key (`2906`). Benestates runs its own ARGUS; nothing here reads or links its data.
- **ARGUS Light** exists in NEXUS behind `NEXUS_HOUSING_PROFESSIONAL`. Not exercised here.

## Earlier baselines

`crossSystem.test.js` keeps the run against `ee61326` (before the push): owner changes never reached ARGUS, NEXUS kept its own timestamp and acknowledged updates without applying them. At `a2068ab` availability and distribution were pushed; passport and schedule were not. Both are closed at `9947028`.

## What the gate still needs

1. NEXUS open item 1 in a committed revision, then this test re-run with no ARGUS database login for NEXUS.
2. A hosted staging environment for ARGUS. Only production exists today.
3. The eight scenarios on hosted staging, plus the ARGUS Property Source Sync and outreach suites in the VPS test container and the NEXUS regressions.

No production deployment and no merge to `main` without approval.
