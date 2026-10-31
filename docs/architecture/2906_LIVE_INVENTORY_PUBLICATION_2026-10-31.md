# CRM → 2906.estate publication (2026-10-31)

## How the site gets listings
- `app/api/properties` (Next) reads `http://VPS/api/properties` with 60 s revalidation.
- `routes/properties.js` reads **`website_properties`**, a projection written by `services/websiteSync.js`. It does an idempotent upsert on `property_reference`, keeps the slug stable, takes at most 10 ranked photos, and carries no owner data or street.

## Evidence (production, read-only, 2026-10-31)
| Finding | Count |
|---|---|
| Shown as **available** while the CRM says rented 92 / archived 45 / not_available 20 / pending_check 10 / upcoming 8 | **175** |
| Website price ≠ CRM price | 42 |
| Published website rows with no CRM record (legacy) | 89 |
| Published and available in the CRM but missing on the site | 1 |

Cause: `websiteSync` was only called from the CRM edit routes. Every other status change (owner reply, board check-out, rentedDetector, ownerFactEngine …) never reached the site.

## Pipeline
1. **Trigger** `properties_website_publication` on the publication-relevant columns raises `website_publication_state.desired_revision`, so no code path can be missed.
2. **Worker** `services/websitePublication.processDue` runs every minute (`cron.js`):
   - It claims due rows with a 120 s lease (`FOR UPDATE SKIP LOCKED`), so no lock is held while publishing and CRM edits never wait.
   - It publishes from the **current** CRM row and records `published_revision` = the revision it read. A change made meanwhile stays pending, so there is no out-of-order revert.
3. **Rules** (business rules unchanged):
   - Only `properties.published` (the existing approval) puts a listing online; Benestates or other inventory is never published unless that flag is set.
   - unpublished / `website_manually_hidden` / staging / archived → off the site (`is_published = FALSE`, nothing deleted)
   - available → listed as available
   - every other CRM status → listed with `status = 'rented'`, which the existing public page shows as unavailable
   - not publish-ready (no photo or description) but already online → only the status is corrected
4. **Failures:** backoff from 30 s up to 1 h; after 8 attempts `failed` (dead letter), shown as **Sync failed**, never as live. Admin retry: `POST /api/crm/schedule-board/listings/:ref/website-sync/retry`.
5. **Reconciliation** (`reconcile`, hourly) re-queues every listing whose public row disagrees on status, price or publication.
6. **Visibility:**
   - Chip on board cards and detail: Draft / Needs approval / Sync pending / Published / Published · unavailable / Unpublished / Sync failed.
   - Admin `GET /api/crm/schedule-board/website-sync`: counts, drift still visible on the site, legacy rows, failures with their error.

## On deploy (needs Kev's OK)
- The migration creates the trigger and state table.
- The first hourly reconcile queues the ~175 falsely-available listings, the 42 price drifts and the 1 missing listing. The worker then changes **live public pages** (25 per minute). That is the intended correction, but it is a public website change.
- The 89 legacy rows without a CRM record stay untouched and are only reported.

## Code
- `services/websitePublication.js`
- migration `20261031_website_publication(.down).sql`
- `cron.js`
- `routes/crmScheduleBoard.js` (chip, admin routes)
- `app/crm/schedule-board/page.tsx` (`WebsiteSyncChip`)
- Tests: `test/websitePublication.test.js` (8)
