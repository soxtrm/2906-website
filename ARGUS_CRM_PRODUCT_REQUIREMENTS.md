# ARGUS CRM — Kevin's binding product requirements

This file records Kevin's current product direction so later edits do not remove, replace, or reinterpret approved behaviour. Treat it as a regression checklist before changing the Schedule Board, listing actions, or outreach flows.

## Mobile Schedule Board

### Top cloud track

- The top navigation is one horizontal track with exactly three primary clouds: **Search**, **Smartfilters**, and **Filters**.
- The ARGUS logo cloud is Search. Use the supplied ARGUS logo asset. Its restrained animated edge can feel futuristic, but must remain clean and readable.
- Tapping one cloud expands that cloud in place. The other two remain visible and shift/compress along the same track. Do not replace the entire row, stack a second navigation row, or make clouds jump between positions.
- Transitions must be continuous and smooth. Avoid instant `display: none` changes during a morph.
- The open cloud is clearly highlighted. Closed clouds remain understandable and tappable.
- The whole top menu compacts while scrolling down and returns when scrolling up or near the top, preserving maximum listing space.

### Search

- Tapping the ARGUS logo morphs that same cloud into the search input.
- Search must filter by useful listing facts such as reference, village, owner/agent and property type.
- Closing Search returns the exact three-cloud default layout.

### Smartfilters

- Smartfilters are individually selectable and support multiple simultaneous choices.
- Selecting one option must not close the panel.
- Bedrooms and property types selected within the same family are alternatives (OR); different filter families combine (AND).
- Selected choices are visually unmistakable and removable with another tap.
- Smartfilters include the useful workspace actions beneath the filter choices in two clear columns: Map, Favourites, Recent, Tags, Swipe Links, Add property, Profile and More.
- Active Smartfilters may show a small count because they are persistent combinations. A visible one-tap **Reset** is required.

### Normal filters

- Normal Filters contain the detailed property criteria: location, price, beds, baths, pets/tenancy, property type, availability/update and rental mode.
- Beds and baths use touch-friendly interactive controls and still allow exact individual selection.
- Regular filters do not show a notification bubble/count on the top cloud.
- Reset must be immediately visible in the open panel, work in one tap, and leave the panel usable. The sticky footer may also keep Clear all.
- Choosing a filter must not close the panel. The user explicitly closes it or taps Show results.
- Outside-tap logic must not make controls or listing settings close before the intended tap is handled.

### Discovery and navigation

- City filters use the tall rounded mobile capsules shown in Kevin's reference, with counts and horizontal scrolling.
- Do not add a redundant Show map control when Map is already available in the top/workspace navigation.
- The bottom navigation sits lower, is deep and rounded, and highlights the current destination clearly. **Map** is written out and visually prominent because it is heavily used.
- Keep useful existing actions and icons. Reorganising the UI must not silently remove working functions.

### Listings

- Listing cards keep their existing actions and status logic.
- Listing images can be browsed left/right by swipe in the focused/card view, with fluid page movement.
- Settings and overflow controls must remain open long enough to interact with them; a click inside must never trigger the outside-close handler.
- Rented listings show `Rented since` using the actual availability-change date.
- The Available action on a rented listing uses the separate owner-inventory follow-up flow and message, not the ordinary availability-check flow.

### Responsive design

- Mobile and desktop share the same ARGUS visual language. Desktop uses the extra width for listings and information density instead of reverting to the old design.
- Dark and light themes both need intentional surfaces, contrast and button states. Light mode must not be a colour inversion of dark mode.
- Preserve reduced-motion accessibility while keeping the normal experience fluid.

## Owner availability flow

- Scan the real owner chats and group an owner's relevant properties instead of repeatedly contacting the same owner/account.
- Owner check-ins contain direct listing links and ask which numbered properties are still on market:

  `Could you please clarify which ones are still on Market, so I can amend?`

  followed by a numbered list.
- The owner can answer `all` or numbers. Listings not confirmed are moved cautiously; do not blindly mark everything rented.
- Rented events are clearly replied/marked in the main chat with the requested strong visual marker.
- Admins need an admin panel that exposes actions, outcomes, account used, skipped/failed items and audit history.

## Outreach queue

- Manual outreach does not preload or silently consume a batch.
- Remove Replace semantics. The operator enters a quantity and uses Add; further quantities add to the existing queue.
- Maximum batch size is 45. The input remains editable and is validated/clamped without force-filling 50.
- Every database pass advances through the unique owner pool. Replacing/adding UI state must never skip untouched owners or restart from the same owners.
- Split work evenly between the configured top-start and bottom-start accounts. Keep all working accounts visible and correctly assigned; do not drop Olga or newly added ARGUS accounts.
- Every attempted outreach produces measurable audit state, including notes-chat logging where configured, counts for queued/sent/skipped/failed and the latest outreach bars/history.
- Never infer success from a small apparent batch; measure the actual attempt and delivery results.

## Release checklist

- Test the complete interaction at 360, 390 and 430 px widths, plus desktop.
- Verify dark and light themes.
- Verify Search, multi-select Smartfilters, regular Filters, Reset, scroll compaction, outside-click handling and bottom navigation.
- Preserve unrelated repository changes and use the established deployment path with rollback available.
