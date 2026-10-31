# Property scorecard fields (2026-10-31)

Existing canonical columns are reused. Only two columns are new.

| Brief field | Column | Status |
|---|---|---|
| Rent type (Long / Winter / both) | `properties.rental_modes` (`long_let`, `winter_let`, `short_let`) via `services/rentalModes.js` | existed; owner chat now fills it (never `short_let` from chat) |
| Available from | `available_date` + `field_provenance.available_from` | existed (ownerFactEngine) |
| Floor | `floor_level` (`ground`, `1..n`, `top`, `penthouse`, `basement`) | **new** |
| Full address / locality | `street` (internal), `town` / `locality_id` | existed. Public pages show locality only (`websiteSync` never copies `street`). Owner chat addresses go to the location request with provenance and never overwrite `street` |
| Garage / parking | `parking_available` (yes/no/null) + `parking_type` (`garage`, `parking_space`, `carport`) | type **new** |
| Subletting | `subletting_allowed` / `subletting_considered` / `subletting_note` | existed. Only an explicit owner statement counts, never inferred (pets ≠ subletting) |

## From owner chat
- `services/ownerFacts.js` extracts floor, parking (+ type) and rent type, from explicit statements only.
- `services/ownerFactEngine.js` writes them with `field_provenance`: value, source message, evidence, observed time, confidence.
- The newest statement wins by message time, so a rescan of older messages never undoes a newer one.
- Facts only land on an unambiguous listing: the owner's only live listing, or a ref/town named in the text, or the recent bot context. For a multi-unit owner with an unclear message, nothing is written.

## In the CRM
- Property page: Floor and Parking type selects; Unknown stays empty.
- Source line per scorecard field: owner chat or CRM, date, evidence.
- CRM edits append `crm_correction` provenance under the same keys.

## Migration
`20261031_scorecard_fields(.down).sql` (`floor_level`, `parking_type`).

## Known gap
- `ownerFactEngine` applies "newest wins" and does not enforce the documented source priority "CRM correction > owner chat". A later owner message can replace a manual correction. This is pre-existing and not changed here.
- Board/matching filters for floor and parking type were not added.
