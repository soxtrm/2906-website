# Mġarr edition — sourced research draft

Language: English. Status: research draft. Checked 18 October 2026 (Europe/Malta).

## Why this locality is next

The public 2906 inventory endpoint contained seven available, image-bearing listings labelled exactly `Mgarr` or `Mġarr` at the time of review. After excluding the 21 localities already represented in the public neighbourhood sitemap and normalising the accented and unaccented spellings, Mġarr was the largest clearly distinct unpublished locality. This count is only an editorial priority signal; it is not a market ranking or a promise of future availability.

Inventory source: https://www.2906.estate/api/properties?limit=1000

## Editorial boundary

The page must distinguish the compact village centre around the parish church from the broader local-council territory. The council's own material places Ġnejna, Għajn Tuffieħa and Fomm ir-Riħ within the locality's coastal context and describes a rural setting with archaeological and fortified sites. Those coastal places must not be presented as if they were interchangeable with a home in the village core.

Żebbiegħ should be described as a separate named edge/context within the Mġarr locality, especially when discussing Skorba. Mellieħa, Manikata, Mosta, Rabat, Baħrija and St Paul's Bay remain separate property-search contexts. The page must not infer municipal boundaries from a map pin or draw a district polygon without a verified boundary source.

Primary locality sources:

- Mġarr Local Council overview: https://mgarrlc.com/
- Council whereabouts and locality context: https://mgarrlc.com/sites/
- Council history page: https://mgarrlc.com/about-3/mgarr-local-council-wins-award/

## Everyday life

Primary HealthCare's current service material places Mġarr in the Rabat Health Centre catchment and lists a Mġarr Community Clinic at the Primary School on St Peter's Street. The eventual edition may name this as a practical public-service anchor, but must tell readers to confirm the current clinic timetable and available services before relying on it.

- Community clinics index: https://primaryhealthcare.gov.mt/en/clinics/malta-community-clinics/
- May 2026 Quality Service Charter: https://primaryhealthcare.gov.mt/wp-content/uploads/2026/05/May-2026-Quality-Service-Charter.pdf

For a current retail example, Maypole's own outlet directory identifies its Żebbiegħ shop on Sir Temi Zammit Street, Mġarr. This can be used as an operator-backed everyday anchor while keeping Żebbiegħ distinct from the village centre. It is not a complete grocery directory or a claim about live stock or delivery.

- Maypole Żebbiegħ outlet: https://www.maypole.com.mt/outlets/zebbiegh/

## Food and restaurants

Mġarr has several operator-backed restaurant examples that can give the edition useful local texture without rankings:

- United Bar & Restaurant describes itself as a family-run restaurant behind the parish church serving Maltese and Mediterranean food: https://unitedmgarrbehindchurch.com/
- Il-Barri's own history page describes its development from a coffee shop and its association with traditional Maltese fenkata: https://il-barri.com.mt/about-the-restaurant/
- Verbena describes a family-run Local Mediterranean restaurant on the outskirts of Mġarr overlooking Żebbiegħ church: https://verbenamalta.com/
- The Malta Tourism Authority's live licensed-establishments register lists Ta' Soldi Restaurant in Mġarr. Licence status and details must be rechecked at release time: https://mta.com.mt/licences/licences/?dir=desc&page=1&size=50&sort=EstablishmentName&type=restaurants

These are examples, not endorsements or a “best of” list. The page must not copy menus, publish volatile prices or opening hours, or imply that one operator represents the entire village.

## Heritage and activities

Heritage Malta identifies Ta' Ħaġrat in the heart/eastern edge of Mġarr and Skorba on the outskirts in Żebbiegħ. Both form part of the UNESCO-listed Megalithic Temples of Malta, but they are distinct sites. Current opening arrangements, ticketing and access must be checked on the day; no evergreen opening promise belongs in the page.

- Ta' Ħaġrat official ticket/site information: https://heritagemalta.mt/store/s22/
- Heritage Malta feature on Ta' Ħaġrat and its relationship to the Mġarr community: https://heritagemalta.mt/news/a-community-affair-ta-hagrat-megalithic-site/
- Skorba official site page: https://heritagemalta.mt/explore/skorba-temples/

The council and VisitMalta identify Ġnejna and Għajn Tuffieħa as coastal places associated with the wider Mġarr locality. The later edition may introduce them as separate coast trips from the village context, but may not claim a walkable route, short transfer, parking availability, safe access, lifeguard cover or current sea conditions.

- Mġarr Local Council whereabouts: https://mgarrlc.com/sites/
- VisitMalta sea overview naming Għajn Tuffieħa Bay, Mġarr: https://www.visitmalta.com/en/experience-the-sea/

## Map rules

Use a fast click-to-load OpenStreetMap overview centred on the village, with the parish-centre context, Ta' Ħaġrat and the direction of Żebbiegħ/Skorba as clearly separated reference points. Do not draw a walking route, road ETA, bus schedule, ferry line, coastline shortcut or administrative boundary. Ġnejna and Għajn Tuffieħa should not be pulled into a tight village-centre crop merely to imply proximity.

## Licensed image candidate

Preferred first candidate: `Malta - Mgarr + Triq is-Santi 01 ies.jpg` by Frank Vincentz (`Ies`), photographed 1 May 2014, 5616 × 3744, licensed CC BY-SA 3.0 (and GFDL) on Wikimedia Commons.

- File page: https://commons.wikimedia.org/wiki/File:Malta_-_Mgarr_%2B_Triq_is-Santi_01_ies.jpg
- Intended licence for the derived web image: CC BY-SA 3.0, with author, source, licence link, date and modification note shown beside the image.

The candidate shows an agricultural/village skyline context with the parish church. It still requires exact original download, checksum, full-pixel visual inspection and a crop/resize decision. It must not be described as a current property view, as the view from any listing, or as proof of present traffic, agricultural activity or construction conditions.

Fallback candidate: `Malta Mgarr Parish Church.jpg`, Medullaoblongata Projekt, 10 September 2013, 3968 × 2976, CC BY-SA 4.0:

- https://commons.wikimedia.org/wiki/File:Malta_Mgarr_Parish_Church.jpg

## Release gates

1. Download and verify the exact licensed image file; record original and derived SHA-256 hashes.
2. Create a separate `noindex,nofollow` preview with visible attribution and no public discovery links.
3. Verify mobile 390×844 and desktop 1440×1000 layouts, image crop, readable captions and zero horizontal overflow.
4. Confirm the map is absent before interaction and that one real OSM iframe loads only after a click, with a fallback link.
5. Recheck every current operator, council, Heritage Malta and health source immediately before release.
6. Add the self-canonical, Open Graph fields and BreadcrumbList only after the preview passes.
7. Add exactly one Marketplace navigation link and one neighbourhood-sitemap entry, then run the production build.
8. Release only from a clean worktree based on current `origin/main`; the older mixed checkout is missing published editions and is not a safe deployment source.
9. After deployment, verify the exact public and CRM URLs, image asset, metadata, lazy map and rollback commit.

No page, navigation, sitemap, backlink or deployment is part of this research step.
