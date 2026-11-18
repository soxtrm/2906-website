# Neighbourhood navigation integrity — 18 November 2026

New verification scope: static links, assets and fragment targets across the marketplace hub and all 81 published editions. This supplements the earlier live delivery/canonical audit; it does not repeat that crawl.

- 82 local HTML documents inspected.
- 1,056 local marketplace references resolved to existing files.
- 263 HTML fragment references inspected; no missing static fragment remained after investigating the single dynamic action below.
- External links, dynamic routes outside `/link-marketplace/`, JavaScript imports and API correctness are outside this audit. Explicitly skipped paths are recorded in the JSON.

The hub's `Saved homes` link uses `href="#saved"` without a corresponding static element. Initial static inspection flagged it. Reading `marketplace.js` established an existing intentional click handler: it prevents hash navigation, activates the saved collection and scrolls to the grid. No product fix was made based on that false positive.

Read-only live Chrome verification at https://www.2906.estate/link-marketplace/index.html at 390px touch/mobile and 1440px desktop confirmed the actual link changes Favourites to `aria-pressed="true"`, leaves the hash empty and causes no page exception or horizontal overflow. This verifies the collection-entry action, not saved-item persistence, completeness of inventory or authenticated workflows. No request form was submitted and no private data was loaded.

Structured results: `internal-link-integrity-20261118.json` and `saved-homes-live-20261118.json`. Audit scripts and browser screenshots are preserved under `artifacts/20261118-link-integrity` in this worktree. No public file, release pointer or scheduler was changed.
