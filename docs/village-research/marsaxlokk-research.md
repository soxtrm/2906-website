# Marsaxlokk edition — sourced research draft

Language: English. Status: research draft — not published. Checked 28 October 2026 (Europe/Malta).

## Why this locality is next

The public 2906 inventory endpoint returned 497 records during this check. Three image-bearing records used the exact locality label `Marsaxlokk`, while the public neighbourhood directory contained no Marsaxlokk edition. This is an editorial coverage signal only: it is not a popularity, demand or quality ranking and does not promise future availability.

- Inventory source: https://www.2906.estate/api/properties?limit=500

## Editorial boundary

Marsaxlokk should be treated as its own south-eastern harbour locality. The edition must not blur the village with neighbouring Birżebbuġa, Żejtun or Marsaskala, and must not imply that every Marsaxlokk address is on the waterfront, overlooks the harbour or sits within walking distance of the promenade.

Delimara and St Peter's Pool require separate access and terrain checks. They may be introduced as wider-area contexts only after primary-source verification; their names must not be used as proof of a property's coast access, swimming access, view or journey time.

The Local Council describes the settlement's relationship with the harbour and Tas-Silġ. That is historical locality context, not evidence for an individual home's address or outlook.

- Marsaxlokk Local Council: https://marsaxlokklc.gov.mt/en/
- Office of the Address Registrar registers: https://address.gov.mt/registers/

## Everyday life

SPAR Malta lists a Marsaxlokk neighbourhood store at the village entrance and describes a single-level grocery format. A future edition can use the store as one operator-backed weekly-shopping example. It must leave current opening hours, stock, delivery, parking and accessibility to the operator's live page rather than converting them into evergreen claims.

- SPAR Marsaxlokk: https://spar.com.mt/spar-marsaxlokk/

Primary HealthCare lists the M'Xlokk Community Clinic on Triq tat-Trinċiera. Its current clinic directory explains that general-practitioner, nurse-led and other professional services vary by clinic and appointment. The May 2026 Quality Service Charter contains dated service details, but the eventual public edition should direct readers to the live clinic directory and appointment channel instead of presenting a fixed timetable.

- Current community-clinics directory: https://primaryhealthcare.gov.mt/en/clinics/malta-community-clinics/
- May 2026 Quality Service Charter, retained as dated supporting evidence: https://primaryhealthcare.gov.mt/wp-content/uploads/2026/05/May-2026-Quality-Service-Charter.pdf

Malta Public Transport's Marsaxlokk results currently list routes 81, 85, 119, X86 and TD10, and identify bus stop 1548 as Marsaxlokk. The same operator publishes Sunday-market diversions. The edition may name the operator and link the current journey tools, but must not freeze a timetable, travel time, frequency or Sunday routing into the page.

- Marsaxlokk route search: https://www.publictransport.com.mt/routes-timetables/Marsaxlokk/
- Current service updates: https://www.publictransport.com.mt/latest-service-updates/

## Food and restaurants

Restaurant coverage should remain operator-sourced and deliberately non-ranked. Two current candidates have their own sites and Marsaxlokk addresses:

- L'Arkati describes a Mediterranean fish and seafood restaurant at 70 Xatt is-Sajjieda in a restored former fishmonger shop: https://larkati.com/
- La Nostra Padrona lists Italian seafood, pasta and grilled fish at 87 Xatt is-Sajjieda: https://www.lanostrapadrona.com/

Their menus, hours, booking conditions, catch availability and event details are changeable. The future edition may state only the operator-confirmed location and broad cuisine positioning, with a visible check date and a reminder to use the live venue pages. Neither venue is a 2906 recommendation or evidence that every home is close to the waterfront.

## Activities and harbour context

The Local Council and Malta Public Transport both describe Marsaxlokk as a harbour village. The eventual page should distinguish a working harbour, the promenade and the Sunday market from residential streets. Market activity and transport diversions can materially change a visit, so the page should encourage an address-specific viewing at the times the reader expects to travel rather than claim that the village is uniformly quiet or busy.

No ranking, guaranteed fishing activity, permanent market schedule, swimming claim or unrestricted coastal access should be inferred. Any later mention of protected landscapes, Delimara or St Peter's Pool requires a separate primary-source check and explicit access caveats.

## Map rules

Use a fast, click-to-load OpenStreetMap 2D overview centred on the village and harbour context. The initial page must contain no iframe. The map must not draw a property pin, administrative boundary, straight connector, walking route, road ETA, ferry route or invented waterfront proximity.

If route functionality is added later, only network geometry may be shown. A harbour crossing must never be presented as a walking line; any water segment requires explicit, source-backed ferry evidence, while waiting time, fare and live departure remain unknown unless connected to a current provider.

## Licensed image candidates

Preferred candidate for visual review: `Marsaxlokk Harbour.jpg` by G. Mannaerts, photographed 5 November 2017, 11,739 × 2,738 pixels, 36.42 MB, CC BY-SA 4.0. It is a wide harbour panorama suitable for a responsive editorial frame, but it must not be described as a current property view or proof of a home's location.

- File page: https://commons.wikimedia.org/wiki/File:Marsaxlokk_Harbour.jpg
- Licence: https://creativecommons.org/licenses/by-sa/4.0/

Additional Commons candidates returned by the API and retained for comparison:

- `Puerto de Marsaxlokk, isla de Malta, Malta, 2021-08-21, DD 01-07 PAN.jpg` — Diego Delso, 21 August 2021, 19,312 × 3,682, 11,958,220 bytes, CC BY-SA 4.0, Commons SHA-1 `3202290b2dfa34f4294e27cf4e97380ce89f2dbb`.
- `Puerto de Marsaxlokk, isla de Malta, Malta, 2021-08-21, DD 08-13 PAN.jpg` — Diego Delso, 21 August 2021, 18,909 × 3,936, 8,979,007 bytes, CC BY-SA 4.0, Commons SHA-1 `8c837d864e2e07801297f715dadf26303357643a`.
- `Malta Marsaxlokk BW 2011-10-04 13-28-13.JPG` — Berthold Werner, 4 October 2011, 3,872 × 2,592, 2,586,958 bytes, CC BY-SA 3.0, Commons SHA-1 `a7edf0842aaed56ef77eb9c1b4ba71c28bdeefe2`.

No image has yet been downloaded, transformed or approved. Before use, the exact original must be downloaded through Commons, visually inspected at full resolution, hashed locally and tested in real 390px mobile and desktop crops. Any derivative must retain visible author, source, licence, capture date and transformation disclosure.

## Release gates

1. Recheck the Local Council, Address Registrar, Primary HealthCare, Malta Public Transport, SPAR and restaurant operator pages immediately before publication.
2. Download and visually inspect the exact licensed original; record source dimensions, licence, Commons SHA-1 and local SHA-256.
3. Produce a proportionate web derivative without generative alteration and verify mobile and desktop framing.
4. Build a separate `noindex,nofollow` preview with one H1, no canonical, no social URL and no public discovery link.
5. Keep Marsaxlokk distinct from Birżebbuġa, Żejtun, Marsaskala and the wider Delimara context.
6. Verify zero horizontal overflow at 390×844 and 1440×1000, full image attribution and no iframe before map intent.
7. Confirm the map creates exactly one real OSM iframe after interaction and draws no route or boundary.
8. Add canonical, social metadata, BreadcrumbList, one directory link and one sitemap entry only after the preview passes.
9. Run the relevant directory, SEO and production-build tests from a clean isolated worktree; publish only through the existing Git/Vercel route with a specific rollback commit.

No page, navigation, sitemap, backlink, account, message or production deployment is part of this research step.
