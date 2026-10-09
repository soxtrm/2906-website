# Mosta edition — sourced research draft

Status: release candidate. The page, canonical, sitemap and internal discovery link are prepared locally; publication is not claimed until build, deployment and live verification succeed.

Verified: 9 October 2026 (Europe/Malta).

## Editorial angle

Mosta should be treated as a central, lived-in town with two distinct layers: the Rotunda-centred town core and the larger everyday-services/retail catchment around it. The edition must not present Mosta as a beach district or as a substitute for Mdina. It should also avoid calling the locality quiet or traffic-free: the Local Council explicitly describes Mosta as lying on the Valletta–Cirkewwa route and experiencing heavy daily north/south traffic flows.

## Facts safe for evergreen copy

- The Mosta Local Council places the locality in central Malta and identifies the Rotunda as its principal landmark. The council also describes the town as urbanised and commercially active. Source: https://mostalc.gov.mt/en/
- The Rotunda operator identifies the building as the Basilica of the Assumption of Our Lady and offers a visitor experience that includes the basilica, crypt, museum, dome areas and Second World War shelter. Current opening hours and admission prices are variable and must be linked rather than copied into evergreen text. Source: https://mostachurch.com/?lang=en
- Heritage Malta identifies Ta' Bistra as the largest known group of tombs and catacombs outside ancient Melite, located at Triq il-Missjunarji Maltin in Mosta. Current hours and ticket prices are variable. Source: https://heritagemalta.mt/explore/ta-bistra-catacombs/
- The Local Council documents the Mosta sections of the Victoria Lines, Wied il-Ghasel/Wied l-Isperanza and other historic places. Access should only be described at the broad level stated by the council; no continuous walking route or current trail condition is yet verified. Source: https://mostalc.gov.mt/en/historical-places/

## Everyday life and food anchors

- PAMA is a verified large-format supermarket and shopping destination on Valletta Road, Mosta. The operator describes a supermarket, mall and retail/lifestyle uses. Do not copy opening hours into evergreen copy. Sources: https://www.pama.com.mt/app/termsandconditions and https://pggroup.com.mt/
- Square PAMA is an operator-verified family restaurant at PAMA Shopping Village serving home-style and Mediterranean food. Hours and offers are mutable and should remain links. Source: https://square.mt/
- Ta' Marija is an operator-verified Mosta restaurant on Constitution Street focused on Maltese cuisine. Marketing superlatives and changing event schedules must be excluded. Source: https://tamarija.com/

These are examples with direct operator evidence, not rankings or exhaustive recommendations.

## Licensed image candidate

- File: `The Rotunda of Mosta in Mosta, Malta.jpg`
- Author: PavleG97
- Date: 26 July 2026
- Licence: CC BY-SA 4.0
- Commons record: https://commons.wikimedia.org/wiki/File:The_Rotunda_of_Mosta_in_Mosta,_Malta.jpg
- Original-file redirect: https://commons.wikimedia.org/wiki/Special:Redirect/file/The_Rotunda_of_Mosta_in_Mosta%2C_Malta.jpg
- Candidate use: exterior context image with visible author, licence and source attribution. Crop/colour changes must be disclosed and the resulting adaptation kept under a compatible licence.

The image has been downloaded and visually reviewed: it is a clear, high-resolution exterior view of the Rotunda with no visible people or unrelated property claim. A resized 1800×1200 WebP (325,024 bytes) is stored at `public/link-marketplace/assets/mosta-rotunda-pavleg97.webp`. It remains unpublished.

## Map and mobility boundary

Use a fast click-to-load 2D area map. It may orient the reader around the Rotunda, PAMA and Ta' Bistra, but must not imply a precise neighbourhood boundary or draw straight lines as walking routes. Walking, bus timetable and live driving information remain separate. No journey duration belongs in the edition until returned by a route source for the exact endpoints.

## Release gates

1. Verify map anchors and exact public entrances independently before adding pins.
2. Recheck every release source immediately before publication; keep mutable hours and prices out of evergreen copy.
3. Only after review: add canonical, sitemap and internal links, run the production build, deploy through the existing reversible path and verify the live URL.

## Draft verification

The local noindex draft was checked at 390×844 and 1440×1000 on 9 October 2026. It has one H1, no horizontal overflow, a decoded 1800-pixel hero and no iframe before interaction. After the map button is pressed, exactly one OpenStreetMap frame is created; the embed, its assets and sampled map tiles returned HTTP 200. These checks validate the draft layout and lazy-loading behaviour, not a public release or a property-specific route.

