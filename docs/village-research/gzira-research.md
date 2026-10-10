# Gzira village research

Status: published at https://www.2906.estate/link-marketplace/areas/gzira.html in commit `175bf9d`; production HTTP 200 verified on 10 October 2026.

Last source review: 10 October 2026.

## Editorial boundary

The future page must treat Gzira as several related contexts rather than one uniform lifestyle zone:

- **Triq ix-Xatt and the waterfront** are the harbour-facing promenade and commercial edge.
- **The inland residential grid and older village streets** form a separate everyday neighbourhood behind the waterfront.
- **Manoel Island** is a distinct heritage and redevelopment context reached by bridge. It must be labelled separately and must not stand in for all of Gzira.

Do not promise blanket walkability, quietness, sea views, parking availability, or a short commute. A property-specific claim needs its own verified location and route.

## Verified locality facts

- The [Gzira Local Council](https://gziralc.gov.mt/en/) describes Gzira as a locality on Marsamxett Harbour whose name refers to Manoel Island. It also records the coexistence of an older core of houses and balconies with extensive modern development.
- The council's [geography and history page](https://gziralc.gov.mt/en/homepage/geography-and-history/) documents Manoel Island, Fort Manoel and the Lazaretto. These are heritage context, not evidence that every Gzira home is beside or inside those sites.
- Malta's [Office of the Address Registrar](https://address.gov.mt/localities/) lists Il-Gzira in the Eastern Region.

## Everyday anchors

These are examples supported by operator or official sources. They are not rankings and their opening hours should remain behind the live source link.

- [Gzira Health Centre](https://primaryhealthcare.gov.mt/en/health-centers/gzira-health-center/) is at Meme Scicluna Square. The official Primary HealthCare page also shows that its service catchment extends beyond Gzira, so the brochure should not describe it as a residents-only facility.
- [The Convenience Shop](https://www.gard.com.mt/the-convenience-shop) is listed by its operator on Triq Sir Frederick C. Ponsonby and can serve as a grocery example.
- [O'Hea Pharmacy](https://www.oheapharmacy.com/) is listed by its operator at 115 Triq Manoel De Vilhena and can serve as a pharmacy and clinic example.

Exact entrances and map pins must be rechecked before publication.

## Food and cafe examples

Use these as neutral examples, never as a best-of list. Do not copy review scores, awards, opening hours, prices, or mutable menus into evergreen copy.

- [Brillace Cafe](https://www.brillacecafe.com/) lists a Gzira location at 61 Triq il-Gzira and describes its coffee and food offer.
- [NOVI](https://www.noviburger.com/) operates in Gzira and describes an American-food and craft-beer offer.

Additional operators may be added only after their current address and direct source have been checked. Isabella Cafe is excluded from this draft because the available site copy is too promotional to support independent editorial claims.

## Licensed image candidate

Preferred hero candidate:

- **File:** `2024 Gzira Promenade 1.jpg`
- **Commons page:** [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:2024_Gzira_Promenade_1.jpg)
- **Author:** Bärwinkel,Klaus
- **Captured:** 4 May 2024
- **Licence:** [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)
- **Original dimensions:** 3941 x 2955 pixels; 2,928,951 bytes
- **Original SHA-256:** `191463BDCAE2A58DBC39DD6405D2682A2E15653EF12550B3F9210A38708D1378`
- **Visual review:** approved as a clear high-angle daytime view of the promenade, street and harbour/marina context. No identifiable person is material at brochure scale.
- **Editorial limit:** the image represents the waterfront context, not the whole locality.

The Commons original was downloaded through the Wikimedia API and verified. A resize-only 1800 x 1350 WebP derivative was created at `public/link-marketplace/assets/gzira-promenade-baerwinkel-klaus.webp`; no crop or visual retouch was applied and embedded metadata was removed. The derivative is 414,728 bytes with SHA-256 `4A0284871C4DF273B54ECD38A5F0BD674221F80F9C89A127D39407878E6F9120`. It has been visually approved, but is not published until a page with visible author, source, licence and transformation attribution is released.

Secondary candidates reviewed:

- `2024 Gzira Promenade 2.jpg` by the same author, CC BY 4.0: valid night view, but weaker as the primary everyday-location image.
- `Manoel Island - Panorama.jpg` by PayniePaynie, captured 3 May 2024, CC BY-SA 4.0: useful only as secondary Manoel Island context because it centres the island and a broad harbour panorama rather than the Gzira neighbourhood.

## Map and mobility rules

- Use the existing fast, click-to-load 2D OpenStreetMap pattern centred on the Gzira core/waterfront.
- Label Manoel Island separately. Do not invent a municipal boundary, a walking line, or a ferry line.
- A straight line over Marsamxett Harbour must never be presented as a walking route.
- Walking, bus schedules, current car traffic, and ferry services are separate datasets and must remain separately labelled.
- No fixed travel time belongs in evergreen copy without a named origin, destination, mode, source and observation time.

## Proposed page structure

1. Waterfront context and orientation.
2. Inland everyday streets and practical services.
3. Manoel Island as a separate heritage context.
4. Neutral food and cafe examples.
5. Click-to-load 2D map with no drawn route or boundary.
6. Links to distinct Sliema, St Julian's and future Msida editions rather than merging those localities into Gzira.

## Release gates

1. Recheck the exact entrances and live operator pages for the health centre, pharmacy and grocery example.
2. Recheck all primary sources immediately before writing the public copy.
3. Recheck all primary and operator sources immediately before release.
4. Add canonical, Open Graph data, BreadcrumbList, internal navigation and sitemap only in the release candidate.
5. Run the repository build and deploy through the established path with a reversible commit.

## Preview verification

Tested locally on 10 October 2026 at 390 x 844 and 1440 x 1000:

- exactly one H1, `noindex,nofollow`, no canonical, and no horizontal overflow;
- the 1800 x 1350 hero decoded at full intrinsic dimensions and the CC BY 4.0 attribution remained visible;
- zero map iframes before interaction;
- one visible OpenStreetMap iframe after the map button, with the embed returning HTTP 200;
- the button hid after activation, a live status message appeared, and the page still had no horizontal overflow.

Visual review passed for the mobile single-column flow and desktop grid. Evidence images are stored at `artifacts/gzira-preview-mobile.png` and `artifacts/gzira-preview-desktop.png`. This verifies the local preview only and is not evidence of a live release.

## Publication verification

Final sources were rechecked on 10 October 2026 before release. The production edition was then verified at 390 x 844 and 1440 x 1000: exactly one H1, self-canonical, three Open Graph fields, one BreadcrumbList and no noindex; no horizontal overflow; the 1800-pixel licensed hero decoded; zero initial map frames and exactly one visible OpenStreetMap frame after interaction. The marketplace index, neighbourhood sitemap and 414,728-byte image asset all returned the released Gzira entry successfully.

