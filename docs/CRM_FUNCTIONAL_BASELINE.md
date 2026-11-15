# ARGUS functional baseline · 15 November 2026

Production records show five manual attempts across two already closed searches between 04:07 and 04:10 Malta time. The second search had no saved budget or bedroom criteria and one location. The existing engine intentionally excludes closed searches. A read-only calculation against the stored criteria bypassing the status gate returned 10 and 5 candidates for diagnosis. The audit did not establish why the searches had been closed.

At 04:09:24 the manual run invalidated eight pending match rows for one closed search. The persistence path treated a closed search as an active search with zero candidates. The backend now exits before persisting or logging a successful run for closed or missing clients. The manual endpoint uses its existing HTTP 409 contract. An active search with no candidates still returns success with zero. No search was reactivated, no match history was rebuilt, and no message was sent during verification.

## Production checkpoint

- The CRM frontend at `https://crm.2906.estate` points to Vercel deployment `dpl_6WGSMWTSetJP5D9oFZYswnfuxM14` on baseline commit `ca51c76175e7d292afebf1017d8a42ba51ffa70c`.
- Backend change `562ef15` was applied at 18:17 UTC. The backend was listening again at 18:17:45 UTC. The public matching endpoint returned 401 without a session. All three service regression cases passed against the files mounted by the live container with a synthetic database.
- Both directions exercised in database read-only mode. Four of eight active searches returned 1, 9, 9 and 9 candidates. The other four returned zero under their stored criteria. Board listing `2906-9315` returned three active clients. Previously invalidated rows remain in history.
- Rollback files are at `/opt/2906-system/backups/crm-matching-20261115T181741Z/base`. Check that both live hashes still match this release before restoring only the two matching service files and restarting and checking backend health.

Gemini returned HTTP 402 for the free-text profile extraction path. Manual matching uses stored criteria and does not depend on that provider. A closed search may be reactivated by staff only after confirming that the client is still looking, since active searches may be eligible for existing automation.

## Tests for future CRM UI changes

For visual changes, save the currently deployed frontend and backend baseline before editing. Preserve existing interactions, business rules, queries, permissions and action side effects unless the founder explicitly requests a functional change. Compare the same scenarios on the baseline and candidate.

Run a production build and start it locally. Set both `CRM_BASE` and `CRM_MOCK_BASE` to the local URL, then run:

```sh
node --test tests/clientgroups-match-state.browser.cjs tests/crm-argus-functional-ui.test.cjs tests/crm-mocked-ui.test.cjs tests/inventory-gallery.test.cjs tests/owner-quality.test.cjs tests/owner-nexus.test.cjs tests/crm-board-search.test.cjs tests/outreach-p0.test.cjs tests/outreach-reopen-cancelled.browser.test.cjs tests/property-sources.test.cjs
node --test tests/availability-owner-routing.test.cjs tests/board-access-onboarding.test.cjs tests/booking-request-flow.test.cjs tests/outreach-reopen-cancelled.test.cjs tests/owner-group-flow.test.cjs tests/property-upload-flow.test.cjs tests/schedule-board-direct-booking.test.cjs tests/agency-board-admin-tools.test.cjs tests/property-distribution.test.cjs tests/availability-agent-links.test.cjs tests/future-property-lock.test.cjs tests/outreach-auto-prepare.test.cjs tests/listing-agent-notify-routing.test.cjs tests/market-followup-review.test.cjs
```

The first command passed 44 tests and subtests. It exercises both directions of matching, closed and empty states, repeat matching, filter reset, malformed intake summary resilience, Board filters, owner-contact visibility by role, inventory gallery, Outreach, and the Owner Quality, Owner Nexus and Property Sources views. Browser tests use intercepted CRM API responses. Both matching tests ran against the deployed frontend with synthetic API responses at 1440px and 390px. The second command passed 17 route and action contract tests. The chat composer also passed at 320px, 360px, 390px and 430px.

Full authenticated production actions, actual message delivery, Incoming approval, and features beyond these tests remain open for end-to-end verification in staging with synthetic accounts and outbound delivery disabled.
