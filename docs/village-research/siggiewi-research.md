# Siġġiewi village edition — research draft

Status: **PUBLISHED — production verified 20 October 2026**
Checked: 20 October 2026
Scope: an independent Siġġiewi edition. This draft is source material for editorial review; it is not a ranking, a promise of walkability, or a property-location disclosure.

## Why this locality is next

The read-only public 2906 inventory returned three listable, imaged homes labelled `malta:siggiewi` at `2026-10-20T16:01:15.317Z`. Among Malta localities without a published village edition, that is currently the largest group. Inventory counts are a changing operational signal, not a quality ranking.

- Inventory source: [2906 / ARGUS public inventory](https://www.2906.estate/api/nexus/inventory)
- Published-edition comparison: [2906 neighbourhood sitemap](https://www.2906.estate/neighbourhood-sitemap.xml)

## Editorial boundary

Treat Siġġiewi as its own Western Region locality. The Local Council identifies the locality as part of the Western Region. The edition should distinguish the compact village core around Pjazza San Nikola from the broader rural and heritage surroundings. It must not silently absorb Żebbuġ, Qrendi, Mqabba or rural sites merely described as being “limits of Siġġiewi”.

The page may describe an inland village setting and the council-documented church and chapel network. It must not claim that every listing is near the square, quiet, traditional, walkable, or served by the same amenities. Property positions remain approximate unless the public record explicitly permits more detail.

Sources:

- [Siġġiewi Local Council — About Locality](https://siggiewilc.gov.mt/en/about-locality/)
- [Siġġiewi Local Council — Churches & Chapels](https://siggiewilc.gov.mt/en/churches-chapels/)

## Everyday services

Use concrete operator and government examples, with a fresh-check note rather than evergreen opening-hour promises:

- SPAR publishes a Siġġiewi branch page for everyday groceries.
- The Convenience Shop group lists MySupermarket Siġġiewi and two MyConvenience Siġġiewi branches.
- Servizz.gov lists a Siġġiewi hub at the Civic Centre on Triq San Nikola.
- Primary HealthCare lists Siġġiewi Community Clinic at 18 St Nicholas Street and places Siġġiewi in the Qormi Health Centre catchment. Service schedules can change and should be linked rather than copied into evergreen prose.

Sources:

- [SPAR Malta — SPAR Siġġiewi](https://spar.com.mt/spar-siggiewi/)
- [The Convenience Shop — locations](https://my.mt/locations/)
- [Servizz.gov — hubs](https://www.servizz.gov.mt/en/hubs/?lang=en)
- [Primary HealthCare — Malta community clinics](https://primaryhealthcare.gov.mt/en/clinics/malta-community-clinics/)
- [Primary HealthCare — health centres](https://primaryhealthcare.gov.mt/en/health-centers/)

## Food examples

- Marilù's is listed by DINE Malta at 66/68 Pjazza San Nikola. Treat it as a directory-backed village-square example and tell readers to confirm current service directly.
- Corinthia Caterers' own il-Kċina page places the restaurant inside the Limestone Heritage setting and describes its current Mediterranean offer. Do not convert that setting into a claim that every Siġġiewi home is nearby.

Sources:

- [DINE Malta — Marilù's](https://dine.mt/marilus)
- [Corinthia Caterers — il-Kċina](https://corinthiacaterers.com/il-kcina/)

## Heritage and activities

The Local Council lists the Saint Nicholas Church, Old Church, St John Church, St Mark Chapel and other chapels as locality heritage anchors. These can support a restrained “around the village” section. Do not invent opening times, admission, accessibility, event schedules, or a connected walking route. Any route shown later must come from routing geometry; a straight line across fields or private land is not a walking route.

Source:

- [Siġġiewi Local Council — Churches & Chapels](https://siggiewilc.gov.mt/en/churches-chapels/)

## Licensed image candidates

`St Nicholas.jpg` is the preferred hero candidate after source-page and full-width visual review on 20 October 2026. It is a sharp 2219×1248 landscape scene of Pjazza San Nikola: the St Nicholas statue is centred, the church dome remains visible behind it, and the surrounding street frontage provides real village context. The dramatic sky is part of the source photograph and must not be presented as a current-weather view. The responsive page crop still needs separate mobile and desktop approval before publication.

1. **Preferred:** `St Nicholas.jpg` — Mr Marlon Vella, 10 February 2020, 2219×1248, CC BY-SA 4.0. Commons describes the subject as the Statue of St Nicholas and provides camera coordinates in Pjazza San Nikola. Required credit: Mr Marlon Vella / Wikimedia Commons / CC BY-SA 4.0; disclose any resize or crop.
2. `The Siggiewi Heritage 14.jpg` — Continentaleurope, 10 February 2018, 1620×1080, CC BY-SA 4.0. Village-heritage context; final scene identification and hero suitability remain unverified.
3. `Siggiewi, Malta - panoramio (126).jpg` — Alan C. Bonnici, 30 May 2015, 2624×1968, CC BY-SA 3.0. Pjazza San Nikola category context; attribution, scene and crop must be retained and checked.

Catalogues and file evidence:

- [Wikimedia Commons — Pjazza San Nikola](https://commons.wikimedia.org/wiki/Category:Pjazza_San_Nikola)
- [Wikimedia Commons — Church of Saint Nicholas, Siġġiewi](https://commons.wikimedia.org/wiki/Category:Church_of_Saint_Nicholas,_Si%C4%A1%C4%A1iewi)
- [Wikimedia Commons — `St Nicholas.jpg`](https://commons.wikimedia.org/wiki/File:St_Nicholas.jpg)

## 2D map plan

Use the same fast, click-to-load OpenStreetMap pattern as the published village editions. The initial page must contain no iframe. The map should open as an area overview with OpenStreetMap attribution and an external-map fallback. Do not draw administrative boundaries, property pins, ferries, walking routes, journey times or distances without verified data.

## Release gate

Before publication:

- verify the preferred hero in the real responsive page crop and preserve author, date, source, licence and crop disclosure;
- recheck every operator and government source;
- write independent Siġġiewi copy with everyday life, food and activities, without reusing neighbouring-page prose;
- add self-canonical, Open Graph fields and one BreadcrumbList;
- add navigation and sitemap entries only in the release commit;
- verify 390px mobile and desktop layouts, image decode, initial zero map iframes, click-loaded map, no horizontal overflow and exactly one H1;
- build from a clean worktree based on current `origin/main`, because the long-lived travel checkout is stale and contains unrelated work.
