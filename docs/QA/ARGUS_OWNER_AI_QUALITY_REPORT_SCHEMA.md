# ARGUS Owner AI weekly quality report schema

Use the existing Learning Desk / CRM notification surface. Do not create another dashboard and do not auto-promote behavior from a single conversation.

Every Monday report records:

- reporting window, deployment commit, router/config hash and active account persona;
- false unavailable / false removed;
- occupied-versus-rentable-place scope mismatches;
- corrected price not persisted;
- viewing offer misinterpreted;
- identity question ignored;
- duplicate or irrelevant follow-up;
- completion claim without committed backend action;
- media job stalled or 0/N queued beyond the measured threshold;
- upload success without validated extraction;
- provider failure code, retry state and age;
- redacted conversation/run ID, evidence reference, proposed correction, reviewer and disposition;
- regression result before promotion and exact diff from the accepted baseline.

Required counters:

```json
{
  "false_unavailable": 0,
  "false_removed": 0,
  "shared_scope_mismatch": 0,
  "price_correction_missed": 0,
  "viewing_offer_misread": 0,
  "uncommitted_completion_claim": 0,
  "stalled_upload_batches": 0,
  "upload_success_without_validation": 0
}
```

Evidence is redacted, source-linked and access-scoped. Protected preferences remain compliance-restricted and are never converted into automated tenant filters.
