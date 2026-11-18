# Ferry source freshness — winter-season check

Checked 18 November 2026, approximately 17:10 UTC. Research evidence only; no route, price, waiting time or live departure was changed or published.

The existing route adapter's Sliema–Valletta evidence was dated 26 October, before the seasonal change. This check concerns current source freshness, not a repeat of the already verified geometry bug fix.

## Primary sources

- [Transport Malta: Grand Harbour and Marsamxett](https://www.transport.gov.mt/maritime/local-waters/passenger-transport-by-sea/ferry-service-grand-harbour-marsamxett-110): identifies Sliema–Valletta and Three Cities–Valletta services and explicitly directs readers to the operator for a changeable timetable. Read through the web research tool. Direct curl returned HTTP 403; no direct authority HTML snapshot or hash is claimed.
- [Operator schedule](https://www.vallettaferryservices.com/schedule/): read through the web tool and downloaded once successfully. Winter is labelled 1 November–31 May. It separates Sliema and Valletta departure columns, and separately identifies Cospicua and Valletta columns for the Three Cities service. Sunday/public-holiday service differs from the regular tables.

The two sources display different adult single fares (authority €1.50; operator €3.00). Their summer end-time summaries also differ. These are observed source conflicts, not a legal determination about fares. Do not publish a reconciled price or silently treat the authority's older-looking summary as current booking data. Use the operator's current information and ticketing terms at the time of travel; no departure or fare is guaranteed by a saved page.

## Implementation implications

- Preserve `LIVE_CHECK_REQUIRED`, unknown ferry waiting time and explicit `Walk + ferry` labelling. A published timetable is not real-time service confirmation.
- Preserve separate outbound/return departure columns; do not turn the table's offset into a verified crossing duration.
- Keep unknown routed ferry names `ROUTED_ONLY`. Existence of a Three Cities corridor does not verify arbitrary OSM names, terminal coordinates or an individual journey.
- Keep routes absent when valid network geometry is unavailable. No straight walking connector, timetable-derived walk duration or fabricated accessibility claim.
- Do not change the adapter's runtime `verifiedOn` merely because this documentation refreshed the evidence. Any later runtime change must pass the existing protected release procedure on the then-current production baseline.

## Saved evidence

In this preserved worktree: `artifacts/20261118-ferry-evidence/operator.html`, SHA-256 `5da2ca11b977c63dd6e5c7de2a12dfe91b09d424b5dba90c6abb38a41a6e85bc`. The raw operator page is an audit artifact, not a public timetable mirror.

Existing Bormla copy already leaves schedules, fares and operating conditions to the live operator and draws no harbour route. No public content defect was established by this source check. No deployment or scheduler change was necessary.
