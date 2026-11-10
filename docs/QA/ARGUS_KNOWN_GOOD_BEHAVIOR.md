# ARGUS known-good behavior — P0 addendum

This addendum extends `docs/ARGUS_KNOWN_GOOD_BEHAVIOR_BASELINE.md`.

1. A partly occupied flat can retain an available room or person-place.
2. “Rented for one person; needs another” never marks the whole property rented.
3. Per-person rent and whole-flat total are independent facts.
4. An owner viewing invitation is not a confirmed appointment.
5. A gender preference is stored only as restricted source wording for human review.
6. Shared-place updates create a committed internal review task before any colleague-notification wording can be approved.
7. Newly changed shared-place replies are review-only.
8. A completion claim is blocked unless its backend action was committed.
9. `0/7` may be shown only with an explicit queued/processing state.
10. Originals and processed files remain distinct; a failed original is never labelled PLUS-enhanced.
11. Progress survives reload and comes from persisted batch/item states.
12. A missing worker heartbeat becomes a visible, retryable stalled state.
13. Duplicate delivery is idempotent by trigger ID and run position.
14. Tests use synthetic records and a simulated image provider; no live outbound message is sent.
