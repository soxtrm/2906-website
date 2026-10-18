# Schedule Board — Search & Filter Audit (2026-10-18)

Branch `claude/board-search-audit`. Method: every server-side filter was driven through the **real** `GET /schedule-board/listings` handler on production data (read-only, 288 active cards) and every returned card was checked against the filter it was asked for; client-side filters were read from `app/crm/schedule-board/page.tsx` and exercised in a mocked browser test (`tests/crm-board-search.test.cjs`).

## 1. What works (verified on production data)

| Filter | Where it runs | Result |
|---|---|---|
| Bedrooms 1 / 2 / 3 / 4+ (multi) | server | ✅ exact match, 4+ = ≥4, OR across picks |
| Bathrooms (multi, "at least") | server | ✅ |
| Price min / max | server | ✅ (max alone = €0..max) |
| Property type | server | ✅ |
| Rental mode (long / winter / short) | server + card | ✅ |
| Confirmed only | server | ✅ |
| Free now / soon / has date / from month | server | ✅ |
| Rented tab | server | ✅ |
| Combination (2 beds + ≤€1 500 + apartment) | server | ✅ 20 cards, 0 mismatches |
| Ref search `2906-9478` and `9478` | server | ✅ |
| Town search `gzira`, `st julians` | server | ✅ |
| Pets / sharing (3-state), subletting, updated within, map rectangle / circle, horizon (active / future) | browser | ✅ logic reviewed |

## 2. Bugs found

| # | Problem | Evidence | Status |
|---|---|---|---|
| 1 | **`#2906-9478` finds nothing** — the ref exactly as every WhatsApp post prints it (`REF #2906-…`) | 0 cards | **fixed** (search text normalised) |
| 2 | **`gżira` finds 10 of Gżira's 24** — accents not folded | 10 vs 24 | **fixed** (ż ħ ġ ċ + accents → plain) |
| 3 | **`st. julian’s` finds 0**, `st julians` finds 9 | 0 vs 9 | **fixed** (dots / apostrophes dropped) |
| 4 | **"Seafronts" discovery chip counts "waterfront", "frontline"** — exactly the wording the backend's seafront classifier rejects | regex on card copy | **fixed** — uses the card's strict `categoryGroups` |
| 5 | **Free text switches every other filter off** (server and browser). "Sliema" + "2 beds" shows all of Sliema | `if (!search && …)` | **open — product decision.** Intended so a ref is always found; proposal: only an exact ref bypasses filters, any other text combines with them |
| 6 | Free text does not search the description ("sea view", "pool" → 0) | 0 cards | open — needs the description in `argus_workspace.board_search_text` |
| 7 | "Townhouse" type chip has 0 listings (none stored with that type); "Commercial" (1 listing) has no chip | DB | open — chip list should come from `/towns`-style counts |
| 8 | 15 listings without bedroom count and 35 without bathrooms disappear as soon as a room filter is used; one listing has **34 bedrooms** | DB | data fix |
| 9 | `LIMIT 500` on the listings query while pets / sharing / updated / quick filters run in the browser — above 500 active listings results go missing silently | 311 active today | open — move to server or paginate before 500 |

#2906-9481 (the Gżira townhouse) is not on the board because it was **deleted from the CRM on 2026-10-18 12:22** via the board ("Deleted from CRM", by an agent); #2906-9482 / #2906-9483 (same flat, €2 400) were uploaded the evening before.

## 3. Added now — "Quick filters" (filter panel)

Facts every card already carries; no backend change. URL-persisted (`?quick=`), counted in the active-filter badge, cleared by Reset.

| Quick filter | Reads | Live count today |
|---|---|---|
| Seafront | `categoryGroups` includes `seafront` (strict classifier) | — |
| Price dropped · 14 days | `latestPriceChangeAt` within 14 days and new < old | of 27 with a price change |
| Viewing booked | `viewingDate` / `viewing` | 19 |
| Hot | `isHotProperty` | 0 |
| My listings | `isMine` | — |

## 4. Recommended for the top menu (tonight's design)

**Top bar (always visible):** Search · Area/Town · Price · Bedrooms · Filters (panel) · Map · Favourites · Sort.

**Inside "Filters":** Bathrooms · Property type · Pets & tenancy · Availability (free now / from month / confirmed only) · Updated within · Rental mode · Quick filters.

**Missing, worth adding next (data needed first):**
1. Furnished / unfurnished, parking / garage, pool, terrace / balcony / garden, lift, sea view — only in free text today; needs a structured extraction (the GPT extraction already reads these at upload).
2. Size m² range — only 21 of 288 cards carry a size.
3. Listed-by agent picker (cards carry `listedBy`), owner reachable / "can ask" (`contact.canAsk`).
4. Winter-let end date (`availableUntil`, 4 cards) as a "free until" filter.
5. Saved searches / "notify me when a match comes in" per agent.
6. Result count + "clear all" pinned in the bar on desktop (the panel has it; the bar does not).
