# ARGUS ↔ NEXUS — compatibility report

2026-11-12 (evening) · ARGUS branch `claude/argus-nexus-owner-link-20261111` against NEXUS `codex/nexus-property-network-20261111` at commit **`a2068ab`** ("Complete signed ARGUS round trip and add professional Housing"). Contract `2026-11-11.v1`, revision 2 ([CONTRACT.md](CONTRACT.md)).

**Result in one line:** with NEXUS pushing, six of the eight gate scenarios pass between the two real implementations locally. Two things from the 2026-11-12 decisions are still open on the NEXUS side — it does not yet push passport, schedule and Q&A changes, and it still reads the ARGUS database directly. The hosted staging run has not happened. **The gate is not passed.**

## How this was verified

`backend/test/crossSystemPush.test.js` starts the real ARGUS routers of this branch and the real NEXUS handler (`server.py` from a clean export of `a2068ab`), each on its own local throw-away PostgreSQL 16 database, and drives everything over HTTP with real signatures in both directions: the owner's actions through the NEXUS Owner Portal API with a real NEXUS account, staff actions through the ARGUS staff API. No stub receiver, no mocked signer. Only committed code was used.

Limits: local loopback, not hosted staging; the https-only rule of the ARGUS sender is bridged by a test transport; NEXUS was given a login on the local ARGUS test database because `a2068ab` needs one (see open item 2). No production data, no VPS, no hosted Supabase.

## Gate scenarios

| # | Scenario | Local, real code both sides | Hosted staging |
|---|---|---|---|
| 1 | Owner edits a property in NEXUS → ARGUS receives the updated data | **Fails (NEXUS).** NEXUS saves the edit and sends nothing. ARGUS's receiver for it is built and tested with signed events (`ownerPush.test.js`). | Not run |
| 2 | Owner confirms availability → ARGUS timestamp updates → NEXUS displays the confirmed value | **Pass.** `properties.last_confirmed_available_at` moves; NEXUS shows exactly that instant; NEXUS's own timestamp column stays empty for the linked listing; a hold does not move it. | Not run |
| 3 | Owner changes distribution permissions → ARGUS applies them | **Pass.** Unknown channel, unknown scope and empty scope are refused before leaving NEXUS, and independently by ARGUS. | Not run |
| 4 | Owner revokes access → downstream sharing is stopped | **Pass.** Grants end in ARGUS, the gate closes, `property.withdrawn` is delivered, NEXUS marks the listing withdrawn, and replaying an older signed update does not revive it. | Not run |
| 5 | Duplicate events do not create duplicate records | **Pass.** The same owner command twice is one answer in ARGUS; a second listing sync is "unchanged"; one listing row in NEXUS. | Not run |
| 6 | Failed deliveries remain pending and retry safely | **Pass.** ARGUS → NEXUS: a dropped connection leaves the event queued, status shows an error, retry delivers once. NEXUS → ARGUS: with ARGUS down the owner gets an error, nothing is half-recorded on either side, the same command succeeds afterwards exactly once. | Not run |
| 7 | Unauthorised events are rejected | **Pass.** Unsigned, wrong secret, wrong key, wrong agency on both receivers; another NEXUS account cannot act on the listing and nothing reaches ARGUS. | Not run |
| 8 | Existing ARGUS and NEXUS workflows continue functioning | **Partly checked.** ARGUS: listing rows untouched except the staff edit made by the test; no swipe-link rows; the outreach and messaging modules cannot be loaded by this code in any suite. NEXUS: Codex's own housing suite 6/6 here. **Not re-run:** ARGUS Property Source Sync and outreach suites (need the VPS test container); NEXUS Booking and Marketplace regressions (Codex reports unchanged results with pre-existing failures). | Not run |

Activation (invitation → claim → staff verification → owner sync) also passes, and ARGUS reports the owner as synced only because NEXUS states it linked every confirmed listing.

## Open items against the decisions of 2026-11-12

| # | Decision | State at `a2068ab` | Who |
|---|---|---|---|
| 1 | NEXUS pushes passport updates, viewing-schedule changes and approved Q&A | Not pushed. They still go to NEXUS's internal outbox for a pull that will not exist. | NEXUS (Codex). ARGUS receiver ready: `property.owner_updated`, `viewing.schedule_updated`, `qa.answer_approved`, `qa.answer_withdrawn`. |
| 2 | No direct database access from NEXUS to ARGUS | NEXUS reads the ARGUS database in 11 places (`NEXUS_HOUSING_ARGUS_READ_DSN`): owner links and claims, listing facts, availability and answers, grants, appointments, source inventory, routes, viewing windows. | NEXUS switches to the read API. ARGUS provides `/read/owner-link`, `/read/properties`, `/read/viewing-busy`, `/read/source-match`. **Still missing in the read API:** the agency-wide reads of the professional workspace (on-market state, live release state, next viewing window), claim status before verification, staff listing lookup by reference. These need to be specified with Codex before the database login can go. |
| 3 | Acknowledgement means validated and persisted | Met in substance: NEXUS now stores the listing projection and answers only after that. It spells it `accepted: true` and returns a count instead of the linked listings for the owner event. ARGUS reads both forms. | NEXUS: switch to `applied: true` and `properties[]` (small). |
| 4 | Availability: one timestamp | Met for ARGUS-linked listings (scenario 2). NEXUS's own column remains for listings from its separately disabled "preverified pilot" path, which has no ARGUS link. | Decide whether that pilot path stays. |
| 5 | Permission vocabulary aligned, mapped, tested, fail closed | Met. NEXUS uses the contract vocabulary for linked listings; the mapping for its five older names is in CONTRACT.md §4a with tests on the ARGUS side. `market`, `contact_owner`, `receive_leads` authorise nothing. NEXUS offers three of the five contract scopes (`photos` and `approved_answers` are not offered yet). | — |
| 6 | Conflicts, versioning, idempotency, retries, out-of-order, no feedback loop | ARGUS: built and tested (ordering by `occurredAt` and `version`, replay-safe, late older events answer `applied: false`). NEXUS: listing events ordered by `occurredAt`, receipts idempotent, canonical conflicts go to a review table. Out-of-order behaviour of NEXUS's own pushes depends on ARGUS and is covered there. | — |

Smaller findings:

- **Retries on the NEXUS side are the owner's.** A push is synchronous; if ARGUS is down the owner sees an error and retries. Nothing is queued in NEXUS. That is safe (scenario 6) but means no automatic retry.
- **Listing references.** NEXUS accepts refs matching `[A-Za-z0-9][A-Za-z0-9_-]{0,79}`. Production refs were not checked against that pattern.
- **Viewing lengths.** Owner schedule 15/30/60 minutes; ARGUS appointments 10/20. ARGUS stores the schedule; it creates no appointments from it.
- **Professional workspace ("ARGUS Light")** exists in `a2068ab` behind `NEXUS_HOUSING_PROFESSIONAL`. It was not exercised here; it depends on open item 2.
- **Fixed on the ARGUS side while testing:** date columns were sent one day early east of UTC (`availableFrom`); a failed routing event was not retried when a later listing event existed.

## Earlier baseline

`backend/test/crossSystem.test.js` keeps the run against NEXUS `ee61326` (Stage A before the push). There, owner changes never reached ARGUS, NEXUS kept its own availability timestamp and acknowledged listing updates without applying them. All three are pinned as gaps in that file and are closed, or refused by ARGUS, at `a2068ab`.

## What the gate still needs

1. NEXUS open items 1 and 2 (and the small item 3) in a committed revision; then re-run `crossSystemPush.test.js` — its one GAP step must fail and be turned into a positive assertion.
2. A hosted staging environment for ARGUS. Only production exists today.
3. The eight scenarios on hosted staging, plus the ARGUS Property Source Sync and outreach suites in the VPS test container.

No production deployment and no merge to `main` without approval.
