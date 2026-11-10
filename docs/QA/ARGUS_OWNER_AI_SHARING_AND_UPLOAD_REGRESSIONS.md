# ARGUS shared-accommodation and Plus Upload P0 regressions

Date: 2026-11-10  
Scope: Owner AI and `!plusupload` / `!gptupload` only

## Permanent suites

- Existing owner golden pack: `ownerGoldenCases.test.js` — 486 cases, unchanged.
- The existing fixture retains the numbered 001–136 control range and its persona/takeover expansions. No separate 136-case executable was present in the authoritative recovery worktree, so this release does not invent an additional result.
- Existing conversation recovery contracts: 9 cases, unchanged.
- Existing upload pipeline and command suites: 24 cases, unchanged.
- Additive P0 suite: `roseSharedFlatPlusUploadP0.test.js` — exactly R01–R28 and U01–U20 (48 cases).

## New state contract

Shared accommodation is not represented by one availability boolean:

- `occupancy_state`
- `whole_property_available`
- `available_room_count`
- `available_place_count`
- `occupied_person_count`
- `sharing_price` (per-person evidence)
- `whole_property_total_rent`
- `viewing_invited`

A message saying that one person occupies a flat while another person is wanted creates an approval-required shared-place task. It cannot create a whole-property `RENTED` action. It cannot auto-send a corrective reply or republish a listing.

Plus Upload has one durable run ID and stable item rows. Operator progress is derived from persisted item states: `RECEIVED`, `QUEUED`, `PROCESSING`, `COMPLETED`, `NEEDS_REVIEW`, `FAILED_RETRYABLE`, `FAILED_PERMANENT`, `CANCELLED`, and `DUPLICATE_LINKED`.

## Commands

```powershell
node --require ./ops/owner-intelligence/backend/test/helpers/extractedFlowStubs.js --test ops/owner-intelligence/backend/test/ownerGoldenCases.test.js
node --test ops/owner-intelligence/backend/test/roseSharedFlatPlusUploadP0.test.js
node --test ops/gptupload-flow/backend/test/gptPhotoPipeline.test.js ops/gptupload-flow/backend/test/gptUploadCommand.test.js
```

No test sends WhatsApp messages, creates live listings, republishes property media or invokes the paid image provider.
