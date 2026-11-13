# NEXUS BRAIN V2 — private presentation

Requested route: `https://nexuslink.fit/rating`. The founder's typed `nexsuslink.fit` does not resolve; the existing Nexus domain is `nexuslink.fit` (verified 13 November 2026).

## Architecture and access

- Existing Next.js 16 / React 19 architecture, isolated from dirty canonical checkout.
- Baseline origin/main: `f364a59a342cb70e3b396969c1fa410c12dac455`.
- Server checks the existing HTTP-only `crm_session` with canonical `/api/crm/me` on every dynamic page request, including RSC. Only `agent.role === admin` may render the presentation. Invalid, unauthorized or unavailable identity fails closed.
- `/rating/session` re-exports the existing CRM login handler. No new password store, identity engine, database or booking logic.
- No public menu, sitemap, search or listing entry. `noindex, nofollow, noarchive`, private/no-store and no-referrer supplement authorization.
- Local automated identity fixtures never deploy as credentials or an authorization bypass. Runtime origin defaults to the established CRM backend.
- Browser interactions only update React state; they send no rating, booking, outreach, profile or merchant writes.

## Interactive modules

Food orbit with six examples; four expectation/reality scenes; 101-position rating slider with raw 9.5 boundary; immutable historical evidence; three six-axis service radars and simulated weights; positive and negative semantic questions with optional skip and editable interpretation; ingredient FIT and unknown preferences; voluntary dish-specific endorsement visibility; six-step merchant loop and local packaging experiment; four vertical teasers.

Generated food assets use fictional examples. Numeric models are explicitly illustrative; no production scoring algorithm or measured merchant outcome is claimed. Friend visibility controls fictional opt-in examples only.

## Verification

Run `node --test tests/nexus-brain.test.mjs` and `npx next build --webpack`, then `node tests/nexus-brain-browser.cjs`. Browser suite starts the actual production build and a loopback identity fixture, visits desktop 1440×1000 and touch 390/430×844, tests authorization in HTML/RSC, and captures evidence/video under `tests/screenshots/nexus-brain-v2` (gitignored).

Whole-repo TypeScript has a pre-existing `lib/crm/ui.tsx:446` NavKey error (`ownerquality`). No new page errors were found. Build config already skips TypeScript; this limitation is recorded rather than hidden.

21st UI build/review skills were applied. Catalog access returned HTTP 401; the orbital composition is original code informed by the public radial-orbital-timeline reference. CLI review returned three informational hardcoded-color findings and zero errors. The navy/ivory/gold/mint palette is deliberate and scoped to this private page.

## Scoped release and rollback

Create a versioned Vercel deployment of the existing project with `--prod --skip-domain`: this does not promote or change the existing 2906 aliases. Confirm READY and access controls before routing. Pin only `/rating`, `/rating/*`, `/nexus-brain/*` and `/_next/static/*` on the existing Nexus Caddy host to that deployment using `ops/nexus-brain/deploy-route.py` and the verified current Caddy SHA256. Existing Nexus documents, APIs, assets and booking services retain their routes.

The script validates a candidate, refuses concurrent config changes, saves an exact timestamped backup, reloads Caddy gracefully, and restores the original if reload fails. Release receipt is `/etc/caddy/nexus-brain-release.json`. To remove this feature without disturbing later edits, remove only the marked BEGIN/END NEXUS BRAIN PRIVATE ROUTE block, validate, then reload. Restore the exact full backup only if the current config hash still equals the release receipt's after hash.

Vercel Deployment Protection stays enabled. The existing automation credential is kept only in `/etc/caddy/nexus-brain-upstream-header.caddy` (root:caddy, 0640) and forwarded to the single pinned upstream over TLS; it is never sent to the browser or committed. The application still checks the admin session. Client requests for a Vercel bypass cookie are rejected/stripped. Rotating that existing credential requires updating this server-only file and revalidating Caddy.

## Remaining limits

This is a functioning private concept presentation, not a deployed ratings engine. Device measurements are headless Chromium mobile viewports on a desktop CPU, not physical phone GPU benchmarks. External authenticated founder access requires an existing ARGUS admin account. No admin password is created, changed or captured. Backend identity transport follows the existing CRM HTTP upstream; a future shared-auth HTTPS migration is separate work.
