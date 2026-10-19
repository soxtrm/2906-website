# ARGUS UI: handover (2026-10-19)

Handover from Claude to Codex (or whoever continues). Read `AGENTS.md` first.
**Nothing here is deployed.** The frontend is not merged to `main`, and the backend route is not on the VPS.

## 1. Branches

| Branch | Base | What | Status |
|---|---|---|---|
| `claude/argus-functional-ui` (this repo) | `origin/main` @ 51c4f1e | Board search audit and ARGUS UI rework | pushed, **not merged** |
| `claude/av-repost-dedupe` (outreach-yes-fix worktree) | `claude/outreach-yes-fix` | `av-date-confirm` dedupe (backend mirror) | pushed, **not deployed** |

Commits on `claude/argus-functional-ui`, oldest first:

1. `54a911f` Board search normalisation, strict seafront, quick filters, audit (`BOARD_SEARCH_AUDIT.md`)
2. `c16309a` Market/Map/Tools, desktop filter column, Save vs Save & Repost
3. `9bae046` Screenshots
4. `e1f8e7d` Desktop header iteration (superseded by 6)
5. `3f11ce1` Cards: full-height photo, rule icons beside the star; filter column collapsed; spacing
6. `422fa2c` **Final layout per founder mockups** (phone and desktop header)

## 2. Final layout (what the founder signed off on)

### Phone (≤760px), top row
`[ ARGUS island (96px, bigger) ] (⌂) (map) (☰) [ € 📅 🛏 🛁 🏢 🐱 ☷ ❄ ]`

- **ARGUS island:** RGB conic border. Tap and it expands horizontally into the search field; Esc or submit collapses it.
- **⌂ Market:** Residential Rent is active. Sales, Commercial and Short stays are disabled, marked "BEN". No data is ever shown for them.
- **Map:** the existing map workspace (`onMapToggle`).
- **☰ Tools:** board operations only (smart combinations, Active, Rented, Add property, Recent updates, WATag select, Swipe Links, Requests, Collection settings, Favourites, Open to check, Smart map & traffic, Nexus Map, Reachout switch). It does not duplicate app navigation.
- **Filter island:** the full 8-icon set. Each icon opens the filter panel scrolled to its section.
- Unchanged: the bottom nav island and the Active / +3 Months / area chip strip.

### Desktop (≥761px)
- **Header, left to right:** 2906 mark · ARGUS island + (⌂)(map)(🔧), left-aligned with the results column · labelled nav (Dashboard, Inventory, Board, Bookings, Outreach, Profile) + "…" More · Nexus + theme.
  - Labels show from 1360px. Below that the nav is icons only, except the current page.
  - Below 1100px, only the current page and More remain; More then also lists the primary items.
  - While ARGUS search is open, the nav labels collapse (`:has()` rule).
- **Left column:** filter accordion (Location, Price range, Booking, Bedrooms, Bathrooms, Property types, Pets/specials, Season). **All sections start collapsed.**
- **Cards:**
  - The photo spans from the card top to the action tray.
  - Rule icons sit beside the star: ❄ winter (rental mode or "Bis" date), ☀ short let, 🐾 pets, 👥 sharing. An explicit "no" is crossed out; unknown is hidden; subletting stays filter-only.
  - The old WINTER/SHORT title tag was removed (it overlapped the price).
- **Theme:** light by default on every device; dark blue via the header toggle (stored in `localStorage.crm_theme_pref`).

### Shared filter state
`components/crm/board-filters.tsx` defines every filter section once (`locationSection`, `priceFields`, `bedsField`, …). The phone panel and the desktop column (rendered through `createPortal` into `#crm-board-filter-rail`) both use these definitions, so chips, panel, column, URL (`?beds=…`) and results stay in sync. Closing a panel never resets filters.

## 3. Save vs Save & Repost

| Where | Save | Save & Repost |
|---|---|---|
| Board calendar icon (`AvDateDialog`, `components/crm/board-dialogs.tsx`) | `PATCH /api/crm/properties/:id` only | PATCH (if changed), then **one** `POST …/listings/:ref/av-date-confirm` |
| Property editor (`app/crm/property/[id]/page.tsx`) | PATCH only (website sync as before) | Admin only: PATCH, then one `av-date-confirm` |

Both have an in-flight `useRef` lock against double taps.

**Backend** (`claude/av-repost-dedupe`, `ops/owner-group-flow/backend/routes/crmScheduleBoard.js`):
- **Durable check:** a 10-minute cooldown based on the `property_activities` row with `activity_type='available_date_confirmed'` and `details.command='av-date-confirm'`.
- **In-process lock:** a `Set` claimed before the first `await`.
- A refused request returns `409 { deduped: true }`.
- Production md5 before the change: `b427eaaba0a22d3e4e617cc847455277` (equal to the mirror). New md5: `80452c441e9da98ba3dcddfe132e0b62`.

`!available` (availability confirmation without a repost) was already live from the earlier work (`handlers/priority.js`, commit 2b813d5). Its optional threaded reply was **not** prepared.

## 4. Files touched (frontend)

- `components/crm/board-filters.tsx`: islands, Market/Tools panels, shared sections, desktop rail portal, `MARKET_OPTIONS`
- `app/crm/schedule-board/page.tsx`: market state, `tools` (= `mobileBoardActions`), `railTargetId`, `sidebar` slot, card photo and rule icons, light-first `isDark`; old `.crm-board-desktop-rail` kept but `hidden`
- `lib/crm/ui.tsx`: `CrmShell` `sidebar` prop, `.crm-agency-brand` (`/logo-wide.png`), header nav, `HEADER_PRIMARY`, More menu
- `components/crm/board-dialogs.tsx`: AvDateDialog Save / Save & Repost
- `app/crm/property/[id]/page.tsx`: Save / Save & Repost
- `app/crm/crm.css`: three appended blocks at the end of the file ("ARGUS functional UI", "pass 2", "pass 3"). Later blocks override earlier ones, so a cleanup pass can fold them together.
- Tests: `tests/crm-argus-functional-ui.test.cjs` (new); `tests/helpers/crm-mock.cjs` (`fixtures.routes` override hook); `tests/crm-mocked-ui.test.cjs` (two assertions moved to the new header/island)

## 5. How to verify

```bash
npx tsc --noEmit -p .
npx next dev -p 3109 --webpack
CRM_MOCK_BASE=http://localhost:3109 ARGUS_SHOTS=docs/argus-ui-2026-10-19 node --test tests/crm-argus-functional-ui.test.cjs   # 10/10
CRM_MOCK_BASE=http://localhost:3109 node --test tests/crm-mocked-ui.test.cjs tests/crm-board-search.test.cjs                  # 14/14
node --test ops/owner-group-flow/backend/test/avDateConfirm.dedupe.test.js   # in the outreach-yes-fix worktree: 3/3
```

The browser tests use a mocked backend (puppeteer). No WhatsApp message, no live API call. Screenshots are in `docs/argus-ui-2026-10-19/`.

## 6. Known gaps / for Codex

- **Superseded tests:**
  - `tests/board-clean-desktop.test.cjs` asserts the old Workspaces island / top rail / centred map link.
  - `tests/rental-modes.test.js` (live backend) expects the WINTER tag beside the locality, which now lives beside the star.
  - Both need updating or retiring.
- `tests/board-area-multiselect-mobile.test.cjs` and `tests/chat-composer-mobile.test.cjs` are hard-wired to `localhost:4174`, so they were not run.
- **Not checked live:** no real CRM session, no Vercel build, no real-device test. Desktop 761–1100px was checked only through CSS logic, without screenshots.
- **Left filter column style:** the founder mockup shows right-aligned uppercase labels with the icon on the right. The current version is a left-aligned accordion. The founder said "only look at the header" for this round; open item.
- `crm.css` has three stacked override blocks, so it's worth consolidating.
- The Market switch is UI-only state (`useState` in the board page), with no URL param and no backend. When the BEN boards exist, wire `market` into the listings query.
- The 10-minute cooldown is a judgement call; the founder can tune `AV_REPOST_COOLDOWN_MIN`.
- Unrelated in-flight work: `claude/nexus-map-perf` has **uncommitted** renderer fixes (flicker, pearl colours, trees). The founder still wants a less chalk-white day ground. Do not lose that worktree.

## 7. Deploy (needs the operator's OK in chat)

1. **Frontend:** merge `claude/argus-functional-ui` into `main`; Vercel deploys it.
2. **Backend:** from the outreach-yes-fix worktree, `ops/outreach-approval-fix/deploy.sh`-style md5-guarded deploy of `routes/crmScheduleBoard.js`.
   - Expected production md5: `b427eaab…`.
   - It takes a backup, runs `node --check`, does one `docker restart 2906_backend`, and aborts if outreach runs are active.
3. **Live check:** admin Save & Repost on one listing, using the test number only. One category post, then a second tap returns 409 `deduped`.
