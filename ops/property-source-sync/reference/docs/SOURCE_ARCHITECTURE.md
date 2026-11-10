# ARGUS External Property Sources — Architecture and Integration Contract

## One source = a provider channel, not a new agency

Admin opens `ARGUS → Integrations → Property Sources` (or compatible Tools section) and adds provider URL and category: `Long Let` or `Sale`. This registers the URL, owner/provider of the listing, permission and operational state, crawl frequency and service role. The first named source is **My Next Home**, not a fictional 2906 owner or 2906-owned listing.

**Source data is evidence, not truth in the canonical CRM.** The owner may change a website, a current tenant might not be moved out yet, and an archived page may remain indexed. Current owner/agent verified facts have distinct timestamps and provenance.

## Flow

`Admin registers authorized source → source URL and rights reviewed → scheduler evaluates source (low frequency, robots and terms respected) → source category links → detail-page parsing → source snapshot with source URL/timestamp and extracted fields → stable external reference matching → canonical property candidate matching → NEW / UPDATED / MISSING_FROM_SOURCE proposals → admin review (field-diff, link, source status, media permission) → authorized approved changes in existing ARGUS property service → existing outbox/publication eligibility → source metrics & history`

No new public listing or WhatsApp message is sent on a passive website change. Explicit Save vs Save & Repost remains separate. Never silently mutate source-protected owner data.

## Source channel record

- `source_id`, tenant/agency scope, source label, allowed host/path, input category, URL, source owner/provider
- explicit proof of authorized website read/sync, contact/licence and permitted text/media use
- `enabled`, `paused_by_policy`, `last_success`, `last_error`, planned next check, rate/minimum interval
- export/API/feed preference over HTML polling where available
- source trust level, field-level authority policy (never blanket higher priority than direct owner confirmation)

## Property observations

- stable `external_id` derived from canonical listing URL; detect URL/slug changes as *possible* duplicates
- source snapshot date/ETag/hash, title, category, price candidates and evidence, period, availability source/date/freshness
- bedrooms/bathrooms/area/property type, private address with separate permissions, image/source URLs and rights metadata
- explicit source status: `LISTED_UNVERIFIED`, `SOURCE_REPORTED_RENTED`, `NOT_SEEN`, `WITHDRAWN`, `UNKNOWN` (do not equate)
- image manifest: source asset URL, checksum if permitted, image order, alt text, owner permission, watermark, no unauthorized copying
- source URL and field-level provenance preserved after accepted import

## Candidate matching (no erroneous merges)

First exact source ID/URL, then owner/unit-aware probable match by canonical unit, floor, normalized building/address, features, existing linked media checksums where permitted. **Same building does not mean same flat.** Multiple agencies may legitimately offer the same physical unit with distinct agency offers/terms. Show possible matches with evidence; do not auto-merge or erase history.

## Update proposal states

- `NEW`: newly discovered source listing; cannot be directly published without rights and approval.
- `UPDATED`: source field(s) changed; show old/current values and source evidence. Default review for pricing, availability, media and transaction type.
- `MISSING_FROM_SOURCE`: after ≥2 successful complete scans listing missing; only **ask/check**, never auto mark rented.
- `UNAVAILABLE_CONFIRMED`: only after an explicit authorized owner/agency status confirmation and normal ARGUS update gate.
- `REJECTED/ACCEPTED` with reviewer, timestamp, original snapshot, source version, audited writes and rollback.

The example code stages approvals locally. Production must write through the **existing** ARGUS property service and follow existing publication rules, with no second inventory database.

## Notifications

- Source sync dashboard shows counts: `5 new`, `3 updated`, `2 need checking` (figures reflect actual events).
- An admin notification only when new event counts change, optionally daily digest; do not flood per scrape.
- Owner's source name and listing link visible; customer/private contacts hidden from shared agent views.
- Tappable diff panel: Price old/new, availability claim, photos count, updated source timestamp, source evidence and duplicate candidates; Approve/Reject/Link Existing/Request Verification.
- Only accepted field changes and permitted media enter existing canonical ARGUS inventory.

## Reliability and security

- Allowed domains/path per source, HTTPS only, host validation after redirects and DNS/IP protections against SSRF.
- Source access signed/authorized, per-provider robots/terms and low-frequency conditional HTTP; use official feeds/API when available.
- Admin-only add/edit/enable, CSRF + server-enforced tenant role, fully audited approvals.
- No credentials or customer PII in worker logs. No copied source phone/email in shared data.
- Avoid downloading/republishing full copyrighted descriptions, gallery photos and ZIPs without rights. Link to source until licensed; use only permitted summaries or metadata.
- Rate limits, backoff, timeout, 404/5xx handling, circuit breaker, idempotent event storage and scheduled reconciliation.
- A failed/incomplete scan NEVER registers an entire category as removed. Date-stamped snapshot versioning, no clock/timezone assumptions.
- Sync one transaction type/category at a time. **Sales page includes an international (Libya) listing; do not treat everything as Maltese inventory.**
- No separate notification/outreach queue: use existing ARGUS outbox and admin alerts. Polling must not send owner WhatsApp messages or re-enable campaigns.

## Important existing project constraints

The user already has ARGUS property IDs, agency tenancy, owner states, 2906 website publication semantics, duplicate review, listing availability confirmation, and separate BENESTATES/REAP scope. Reuse those. Do not create another scheduler, booking core, sales database or mirror private property data into Nexus Housing without approval.

The 2026-11-09 local prototype intentionally stores its own SQLite database only to demonstrate stable source snapshots and review workflow; it is *not* the canonical ARGUS database and should not be shipped as a standalone production service.
