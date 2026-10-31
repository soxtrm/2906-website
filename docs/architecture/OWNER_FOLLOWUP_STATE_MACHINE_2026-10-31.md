# Owner follow-up questions (2026-10-31)

The existing state machine in `services/autoOwnerConversation.js` is unchanged in its rules:
- `nextMissingField` with stages: MUST fields → photos/map → pets/sharing → subletting
- ask-once fields
- "unresolved after two attempts"
- the optional-cascade stop rule
- the cooperation gates

## What changed
1. New optional fields `floor`, `rent_type` and `parking` (ask-once):
   - floor is always eligible
   - rent type is eligible for rentals only
   - parking is Stage 3, like pets
2. `services/ownerQuestionPlan.js` (pure) turns the chosen field into a bundle of the related missing facts:
   - **address + floor**: both missing → one question; address known → only the floor; floor known → only the address
   - **available-from + rent type**: "Is it for a long let or a winter let, and from when would it be available?"
   - **parking + subletting**: the garage/parking question first, then Kev's subletting sentence **verbatim**
   - A companion joins only if it is unknown, not asked before, not unresolved, and passes the same stage gate.
   - Companions sent in the same message are marked as asked, so they are never asked twice.
3. Every owner reply runs through the deterministic extractor (`ownerFacts.extractFacts`). Stated floor, parking and rent type fill the checklist only when unknown; an earlier explicit answer is never overwritten.
4. Drafts get `floor_level`, `parking_available`, `parking_type` and `rental_modes`. Existing CRM listings get them in the notes, and live listings are written by `ownerFactEngine` with provenance.

## AI boundary
The LLM only phrases the question. Values come from deterministic extraction:
- the checklist merge and the `ownerFactEngine` provenance
- validation by explicit-statement regex, multi-unit binding, newest-wins
- ambiguous cases → no write

## Multi-property owners
- `ownerFactEngine.resolveProperty` binds a fact only to an unambiguous unit; "several listings, no clear unit" → nothing is written (tested).
- Images and addresses in the intake are handled by the existing flow. A "Which apartment is this photo for?" prompt was **not** added.

## Not done
- A per-owner "busy" stop beyond the existing stop rule and pace logic.
- A dedicated multi-unit candidate list.
- An admin UI to rebind an image or extraction to another unit.
