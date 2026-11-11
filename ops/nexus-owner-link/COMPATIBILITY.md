# ARGUS ↔ NEXUS Owner Portal Stage A — compatibility report

2026-11-12 · ARGUS branch `claude/argus-nexus-owner-link-20261111` against NEXUS `codex/nexus-property-network-20261111` at commit **`ee61326`**.

**Result in one line:** invitation, activation, claim, verification, property linking and dispute handling work end to end between the two real implementations. Everything the owner does afterwards in NEXUS (availability, distribution) does **not** reach ARGUS at `ee61326`, and NEXUS keeps a second availability timestamp. The integration gate is therefore **not passed**.

## How this was verified

Not by reading alone. `backend/test/crossSystem.test.js` starts the real ARGUS routers and the real NEXUS handler (`server.py` from an export of `ee61326`), each on a local throw-away PostgreSQL database, and drives the full path over HTTP with real signatures on both sides. No stub receiver, no mocked signer. Result: **8/8 steps pass**; two of them are marked GAP and pin the mismatches below, so they fail as soon as a mismatch is fixed.

Limits of this run: local only (PostgreSQL 16, loopback HTTP, the https-only rule on the ARGUS sender bridged by a test transport). It is **not** the staging test the gate requires. No hosted Supabase, no VPS, no production data.

## What works between the two real systems

| Area | Finding |
|---|---|
| Invitation link | ARGUS's default link `…/owner/activate#t=<token>` opens the NEXUS activation page. Token format accepted by both. |
| Invitation redemption | NEXUS resolves the token through `POST /api/nexus-link/v1/invitations/resolve`, signed, key `nexus`. Only `externalId`, `town`, `propertyType` reach the browser. No street, phone or owner contact. |
| Claim | `owner.claim_submitted` is accepted by ARGUS. The owner becomes *claimed*, not verified. The link is single-use: a second NEXUS account gets 409. |
| Identity mapping | NEXUS account id (`nxu_…`) is stored as `nexus_account_ref`; one account per owner link per agency. |
| Verification | Stays an explicit ARGUS staff step. Before it, `sync-owner` is refused and NEXUS shows no property. |
| Property link | After `owner.profile_upserted`, NEXUS links exactly the properties the owner confirmed (the rejected one is not linked) and mints one canonical UUID per ARGUS property. |
| Signatures | Same scheme both ways (`v1=HMAC-SHA256` over `timestamp.METHOD.path.sha256(canonical JSON)`, 5-minute window). Canonical JSON of both implementations agrees. Distinct secrets per direction. |
| Negative authorisation | NEXUS answers 401 for unsigned, wrong-secret and wrong-key requests and 403 for another agency key. ARGUS's own service surface was already covered in `routes.test.js`. |
| Duplicate processing | Replaying a delivered event returns the stored result and creates nothing; the same event id with changed content is refused with 409. |
| Account isolation | Another NEXUS account sees no property and cannot open it. |
| Dispute | An ARGUS dispute removes the owner's access in NEXUS on the next request. |
| Sync acknowledgement (ARGUS → NEXUS) | `property.upserted` is acknowledged with `canonicalPropertyId` and `publicationState`; ARGUS stores both. |

## Mismatches at `ee61326`

| # | Area | What happens | Effect | Proposed owner |
|---|---|---|---|---|
| 1 | **Availability timestamp** | NEXUS writes its own `housing_properties.availability_last_confirmed_at` when the owner confirms. It neither reads nor updates ARGUS's `properties.last_confirmed_available_at`. | Two timestamps that drift apart. Violates the "one timestamp" requirement. An owner confirmation in NEXUS does not refresh ARGUS. | NEXUS: send `availability.answered` to ARGUS and display ARGUS's value. |
| 2 | **Owner → ARGUS direction** | NEXUS puts owner changes into its own outbox for ARGUS to **pull** (`GET /bridge/events` + ack). The contract defines **push** to `POST /api/nexus-link/v1/events`. ARGUS has no poller; NEXUS has no pusher. | Nothing the owner does after activation reaches ARGUS. | One side must move. Recommended: NEXUS pushes (ARGUS already receives, verifies and deduplicates these events). |
| 3 | **Distribution permissions** | NEXUS: five permissions granted to the one agency (`view_facts`, `market`, `contact_owner`, `manage_viewings`, `receive_leads`). ARGUS: channel × audience × scopes (`origin_agency`, `selected_agency`, `all_eligible_agencies`, …). No mapping, no delivery. | ARGUS never sees a grant, so its gate blocks every property with `NO_DISTRIBUTION_AUTHORIZATION`. Agency routing can never be owner-authorised. | Product decision on the mapping, then NEXUS sends `distribution.granted` / `distribution.revoked`. |
| 4 | **Canonical property id** | NEXUS returns the canonical id only in the `property.upserted` acknowledgement. ARGUS only sends `property.upserted` once a grant exists (mismatch 3). | ARGUS never learns the canonical id, so it cannot call NEXUS's property routes. | NEXUS: return `[{externalId, canonicalPropertyId}]` in the `owner.profile_upserted` reply; ARGUS stores it. |
| 5 | **Property payload ignored** | NEXUS acknowledges `property.upserted` but applies none of it. Its passport is a one-time snapshot read from the ARGUS database at link time. | ARGUS shows "synced" while a later price change never reaches NEXUS (test: 1500 → 1650 stays 1500). | NEXUS: apply the payload, or the contract must say Stage A is identity-only and ARGUS must not call it "synced". |
| 6 | **Direct database read** | NEXUS reads ARGUS's PostgreSQL directly (`NEXUS_HOUSING_ARGUS_READ_DSN`): `properties`, `owner_contacts`, `nexus_owner_links`, `nexus_owner_property_claims`, `website_source_inventory`, `property_viewings`. | Outside the contract. Needs a new read-only login with column grants on the production ARGUS database and a network path to it — a production change that needs approval. Schema changes in ARGUS can break NEXUS silently. | Decision: accept and document as part of the contract, or replace with signed read endpoints. |
| 7 | **Routing events** | NEXUS rejects `distribution.released` / `distribution.release_revoked` with 400. | Would dead-letter in ARGUS. **Handled on the ARGUS side:** these events are now held until `NEXUS_LINK_ROUTING_EVENTS=1`. | NEXUS: consume them (Stage B). |
| 8 | **Listing references** | NEXUS accepts refs matching `[A-Za-z0-9][A-Za-z0-9_-]{0,79}` only. One ARGUS ref with another character (space, dot, slash) fails the whole `owner.profile_upserted` with 404, which ARGUS treats as permanent. | One odd ref blocks the whole owner. Not checked against production refs. | Check production refs before staging; NEXUS should skip, not fail. |
| 9 | **Zero links reported as success** | `owner.profile_upserted` answers 200 with `linkedProperties: 0` when nothing could be linked, and stores that answer for every retry. | ARGUS shows the owner as synced with nothing linked, and cannot re-send (same payload). | ARGUS: treat a count below the confirmed claims as an error. NEXUS: do not store a receipt for an empty result. |
| 10 | **Viewing durations** | NEXUS offers 15/30/60 minutes; ARGUS's appointment constraint allows 10 and 20. NEXUS already notes this. | Viewing requests cannot become ARGUS appointments yet. | Coordinated later release. Out of scope here. |
| 11 | **Error body** | NEXUS answers errors as `{message}`, ARGUS expected `{error}`. | Lost error text in the ARGUS sync status. **Fixed on the ARGUS side.** | — |

Organisation isolation: NEXUS Stage A hard-codes the agency `2906` (one organisation row, one key, one secret) and enforces it with row-level security and per-request agency scope. That is consistent with ARGUS's single-instance `ARGUS_AGENCY_KEY`. It is single-agency by construction, not yet multi-tenant; a second agency needs its own key, secret and organisation before any Benestates data is involved.

## Codex work in progress (not committed, not tested)

While this run was being made, the NEXUS worktree at `C:\Users\kevin\nexus-work\20261111\property-network` held **uncommitted** changes that move in the direction of mismatches 1, 2, 3 and 7: NEXUS pushes `availability.answered`, `distribution.granted` and `distribution.revoked` to ARGUS in the contract format, reads `last_confirmed_available_at` and the grants from ARGUS, adopts the same freshness thresholds, accepts the two routing events and adds a receiver path `/api/nexus/workspaces/argus-link/v1/events`. At the time of checking that tree did not import (`nexus_housing_market` was missing), so nothing of it is verified here. Re-run the cross-system test against the next Codex commit:

```bash
NEXUS_REPO_DIR=<clean export of the commit> NEXUS_PYTHON=<python with psycopg, tzdata> node --test --test-concurrency=1 test/crossSystem.test.js
```

The two GAP steps are expected to fail then; that is the signal to turn them into positive assertions.

## Integration gate — status

Required: ARGUS owner → invitation → NEXUS activation → property link → owner-approved update → ARGUS/NEXUS synchronisation → authorised visibility, on staging, plus negative authorisation and duplicate processing.

| Step | Local, real code both sides | Staging |
|---|---|---|
| Owner → invitation → activation → property link | Pass | Not run |
| Negative authorisation, duplicate processing | Pass | Not run |
| Owner-approved update → synchronisation | **Fails at `ee61326`** (mismatches 1–3) | Not run |
| Authorised visibility | Not testable: NEXUS Stage A publishes nothing, ARGUS Light does not exist yet | Not run |

Blockers for the staging run: a committed NEXUS revision that closes mismatches 1–4; a staging ARGUS (there is only production — a staging database and backend need to be provided or approved); the decision on mismatch 6; secrets for both directions set on both sides.
