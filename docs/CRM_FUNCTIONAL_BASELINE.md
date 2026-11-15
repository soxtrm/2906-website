# ARGUS functional baseline · 15 November 2026

The production matching service returned ten candidates for a sampled active client using its stored criteria. The two client records from the reported runs were closed. A read-only calculation with one closed record's stored criteria returned ten candidates. The second had no saved budget, bedroom or location criteria. Closing can originate in more than one workflow. The audit did not establish which closed these records. No client status was changed or message sent.

Gemini returned HTTP 402 for the free-text profile extraction path. Manual matching uses stored criteria and does not depend on that provider. A closed search may be reactivated by staff only after confirming that the client is still looking, since active searches may be eligible for existing automation.

## Tests for future CRM UI changes

Run a production build and start it locally. Set both `CRM_BASE` and `CRM_MOCK_BASE` to the local URL, then run:

```sh
node --test tests/clientgroups-match-state.browser.cjs tests/inventory-gallery.test.cjs tests/owner-quality.test.cjs tests/owner-nexus.test.cjs tests/crm-board-search.test.cjs tests/outreach-p0.test.cjs
node --test tests/availability-owner-routing.test.cjs tests/board-access-onboarding.test.cjs tests/booking-request-flow.test.cjs tests/outreach-reopen-cancelled.test.cjs tests/owner-group-flow.test.cjs tests/property-upload-flow.test.cjs tests/schedule-board-direct-booking.test.cjs
```

The first command passed 18 browser assertions and subtests on Chromium. It covers closed, empty and successful search states, filter reset and malformed intake summary resilience, Board search and filters, inventory gallery, Outreach controls, and Owner Quality and Owner Nexus views. The browser suite uses intercepted CRM API responses and does not deliver external messages. The second command exercises guarded route and action contracts.

For subsequent visual revisions, run these checks against the tested base and the change. Treat absent credentials, skipped checks and stale assertions as gaps. The existing owner-contact locked-copy assertion fails on the source baseline and requires a real role-aware browser check before changing contact behavior. Full authenticated production actions, external sends, and every feature outside this test list were not verified in this run. Test those in authorized staging with synthetic accounts and outbound delivery disabled.
