# Msida edition — sourced research draft

Status: published at https://www.2906.estate/link-marketplace/areas/msida.html in commit `fe165d7`; production HTTP 200 verified on 10 October 2026.

Last source review: 10 October 2026 (Europe/Malta).

## Editorial boundary

Msida should not be presented as one uniform waterfront neighbourhood. A useful edition needs to distinguish at least three contexts:

- **Msida Creek and the parish-church waterfront**, where the harbour edge, main roads and the changing public-realm project meet.
- **The inland streets around Valley Road and the older settlement**, which are a separate urban context behind the creek.
- **Tal-Qroqq and the University of Malta campus**, which sit uphill from the waterfront and should not be described as if they were on the same block.

Swatar also needs careful labelling. The Office of the Address Registrar lists `Is-Swatar, L-Imsida` under the Msida council, but a property-specific address is still required before assigning a listing to that area.

Do not promise blanket walkability, a quiet street, easy parking, a marina view or a short campus commute. Msida's junctions, elevation and construction conditions make route-specific checks necessary.

## Facts safe for evergreen copy

- [Msida Local Council](https://msidalc.gov.mt/en/) describes the locality as a former fishing village that became more urbanised and now has a strong university-town role. The council also distinguishes the earlier settlement around Valley Road and nearby roads from later development. Its undated population figures should not be reused as current statistics.
- Malta's [Office of the Address Registrar](https://address.gov.mt/localities/) lists `L-Imsida` and `Is-Swatar, L-Imsida` in the Eastern Region. This establishes administrative context, not a property boundary or walking route.
- The [University of Malta](https://www.um.edu.mt/about/contactus/) identifies its main campus as the Msida Campus, MSD 2080. Its separate [campus map](https://www.um.edu.mt/media/um/docs/campuses/CampusMap_18.08.25.pdf) documents campus entrances and facilities. Those sources support a Tal-Qroqq/campus section but do not establish a commute time from any listing.
- A [13 July 2026 government release](https://www.gov.mt/en/Government/DOI/Press%20Releases/Pages/2026/07/13/PR261177en.aspx) records the opening of a new public square and sections of waterfront promenade as part of the wider Msida Creek project. This is a dated completion snapshot; the edition must not imply that every surrounding project phase or traffic arrangement is complete without a fresh check.
- Primary HealthCare's [community-clinic directory](https://primaryhealthcare.gov.mt/en/clinics/malta-community-clinics/) lists the Msida Community Clinic at the Local Council in St Augustine Street. Service schedules and appointment rules are mutable and should remain behind the official link.

## Everyday life and food candidates

- [Welbee's store locator](https://welbees.mt/store-locator) identifies its Campus supermarket at University of Malta, Tal-Qroqq, Msida MSD 2080. This is a directly operator-backed weekly-shopping anchor for the campus context. Current hours, stock, promotions and the distance from a listing remain mutable and should not be frozen into evergreen copy.
- [Busy Bee's published Msida menu](https://busybee.com.mt/wp-content/uploads/2025/10/BUSY-BEE-MENU-MSIDA_2025.pdf) supports Busy Bee as an operator-backed Msida food example. The current branch address, opening hours and menu should be rechecked on the operator's main site immediately before publication.
- [Shakinah](https://shakinahmalta.com/) identifies its restaurant at 11 Ta' Xbiex Seafront, Msida and describes Indian curries, tandoori dishes, breads and sharing plates. It can serve as a waterfront dining example without copying promotional quality claims, prices or mutable opening hours.

These entries are examples, not rankings or an exhaustive guide.

## Image candidate

Approved candidate: [“Malta - Msida - Misrah Guze Ellul Mercer - Msida Parish Church.jpg”](https://commons.wikimedia.org/wiki/File:Malta_-_Msida_-_Misrah_Guze_Ellul_Mercer_-_Msida_Parish_Church.jpg), Txllxt TxllxT, photographed 9 October 2017, own work, CC BY-SA 4.0. Commons reports an original size of 7,549 × 3,064 pixels and camera position 35.895939, 14.490154.

The original was downloaded through the Commons API and verified as a 24,302,663-byte JPEG with SHA-256 `BE44A4CFFA49E91D2DFF26D01F7922C3884096F4AC70CD0CBC0841429F9C196F`. A resize-only 1,800 × 731 WebP was generated at `public/link-marketplace/assets/msida-waterfront-txllxt.webp`; it is 240,394 bytes with SHA-256 `8B19AED89FDBB2A411AB279FAF8D249612299114D5AED9DB8CA7FB0F47B09630`.

Visual review confirms a sharp wide panorama containing the parish church, landscaped edge, open waterfront space and marina. The photographer's shadow appears at the lower centre of the original frame; any hero treatment must use a transparent CSS crop that keeps the church and harbour context while excluding that lower edge, and the visible credit must disclose the resize/crop. The camera coordinate is not a locality centre, property position or route waypoint.

## Map and mobility rules

- Use a fast click-to-load 2D OSM overview covering the creek, inland streets and campus context.
- Do not draw a district boundary, direct harbour shortcut, ferry line or straight-line walking route.
- Keep walking geometry, bus information, current road-traffic estimates and taxi-price observations as separate sourced layers.
- A property page may state a travel time only after a route request for that property's coordinates and the relevant mode.

## Release gate

1. Recheck the weekly-shopping and dining operators immediately before release.
2. Test the approved image in the intended mobile/desktop hero crop and retain visible attribution.
3. Build an independent English noindex preview with everyday life, food, campus/waterfront context and a click-to-load 2D map.
4. Test at 390 px and 1440 px, including image decode, map loading, overflow, one H1 and accessibility labels.
5. Recheck sources, then add self-canonical, social metadata, BreadcrumbList, Marketplace navigation and sitemap only for the release commit.
6. Deploy through the existing path and verify the exact production URL before recording the edition as published.

## Preview verification

Tested locally on 10 October 2026 at 390 x 844 and 1440 x 1000:

- exactly one H1, `noindex,nofollow`, no canonical, and no horizontal overflow;
- the 1800 x 731 hero decoded at full intrinsic dimensions, the CSS crop excluded the photographer's shadow, and the CC BY-SA 4.0 attribution remained visible;
- zero map iframes before interaction;
- one visible OpenStreetMap iframe after the map button, with multiple OSM responses returning HTTP 200;
- the button hid after activation and a live status message appeared.

Visual review passed for the mobile single-column flow and desktop grid. Evidence images are stored at `artifacts/msida-preview-mobile.png` and `artifacts/msida-preview-desktop.png`. This verifies the local preview only and is not evidence of a live release.

## Final source recheck

Immediately before preparing the release candidate on 10 October 2026, the Local Council, Office of the Address Registrar, University of Malta, government waterfront update, Primary HealthCare, Welbee's, Busy Bee and Shakinah sources were rechecked. The locality, campus, clinic, waterfront and operator-backed examples remain supported. Mutable hours, prices, menus, route times and unfinished-project assumptions remain outside the evergreen claims.

No external backlink has been published for this edition.

## Publication verification

The production edition was verified at 390 x 844 and 1440 x 1000: exactly one H1, one self-canonical, three Open Graph fields, one BreadcrumbList and no noindex; no horizontal overflow; the 1800 x 731 licensed hero decoded and its attribution remained visible; zero initial map frames and exactly one visible OpenStreetMap frame after interaction, with successful OSM responses. The marketplace index, neighbourhood sitemap and image asset returned the released Msida entry successfully.
