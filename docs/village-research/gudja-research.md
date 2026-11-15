# Il-Gudja — source dossier for an independent village edition

Status: **PRIVATE PREVIEW VERIFIED — NOT PUBLISHED**. Research and selected photograph checked 14 November 2026. Intended language: English. Intended URL: `https://www.2906.estate/link-marketplace/areas/gudja.html` (not created, not live).

## Scope and preserved baseline

Il-Gudja is a separate local council in the Southern Region, as listed by the [Address Registrar](https://address.gov.mt/local-council/). It is absent from the 64 completed editions in the carried travel snapshot. This is a coverage decision, not a demand, property-inventory or quality ranking. No private listings were queried.

The clean research worktree is `D:\2906\nexus-bridge-work\20261114\gudja-research`, branch `travel/gudja-research-20261114`. It was created from `origin/main` `f364a59a342cb70e3b396969c1fa410c12dac455`; the completed travel work through Tarxien publication was then carried forward. The pre-edit HEAD is `72cab4096ef9d5a3c2aa87852e42d0f9aebd08ba`; the worklog SHA-256 before this step is `d4541149cc6e7b666120a04a3d64990db57534c225d6f8d53012df004ffcf369`. A new fetch on this heartbeat confirmed the same origin/main. The dirty canonical checkout and all other worktrees were preserved.

The latest documented public travel source is Tarxien `508788a37dfea26c511186c923c463377edf6690`, with publication evidence on `travel/tarxien-publish-20261114` at `0006fba8c7c0b8d4df72bd149054dbebc390892d`. These are recorded prior-release facts, **not a fresh live-pointer check**. No deployment or alias operation belongs to this research step. A later release must independently query current 2906, NEXUS and Brain pointers and overlay only the travel delta onto the latest production snapshot. `origin/main` alone does not contain all published travel work.

## Editorial direction: village streets and an airport edge

The useful distinction is between the village core, Bir Miftuħ and the airport/SkyParks environment. An MTA record whose town field says GUDJA can describe an airport departure lounge. It does not establish an accessible village restaurant. Luqa, Ħal Għaxaq and Santa Luċija remain separate localities; neither a street name nor a nearby airport business should merge them into Gudja.

The [local council](https://gudjalc.gov.mt/en/) describes a village centred on its parish church, with limestone balconies and historical street details. It places Bir Miftuħ on the outskirts. The edition can introduce those two settings without promising that every historic building is open. The council also refers to private property in its historical overview; do not turn the Palazzo d'Aurel/Tax-Xlejli context into an unrestricted visitor attraction. Avoid precise church construction/architect dates where the consulted pages differ or are unnecessary.

Keep four practical contexts distinct:

- **Village core / Triq il-Kbira:** parish surroundings and an address-led introduction to everyday streets. A named street is not a verified walking itinerary or a claim of step-free access.
- **Vjal it-Torri / William Baker Street:** grocery and community-clinic directory anchors. Neither is an assurance of opening or immediate service.
- **Triq Ħal Tarxien / industrial edge:** the register explicitly locates Jammin at Dalli Industrial Estate. Do not depict it as a main-square dining room.
- **Bir Miftuħ / airport context:** a separately planned heritage visit and separately checked airport transport. No straight-line airport shortcut, guaranteed walking time or airside access claim.

This should remain a 2906 Local Life brochure with 2906's agency role intact and Nexus identified separately as local discovery context. No parallel directory, ranking engine or property database is needed.

## Activities with primary-source support

The [council's church directory](https://gudjalc.gov.mt/en/churches-chapels/) lists the parish church, Bir Miftuħ and several other chapels. It verifies those names, not current visitor access or services. The [open-spaces directory](https://gudjalc.gov.mt/en/open-spaces-gardens/) identifies Lieutenant's Garden / Ġnien il-Kmand. Use it as a place to check before visiting; do not assert opening hours, facilities or accessible entrances from a map pin.

The current custodian page is [Din l-Art Ħelwa: Chapel of Santa Marija ta' Bir Miftuħ](https://dinlarthelwa.org/chapel-of-santa-marija-ta-bir-miftuh/). It describes a fifteenth-century chapel, surviving frescoes and cultural events, and states limited opening on the first Sunday of a month or by appointment. Link to the custodian for the actual visit date; do not hard-code a recurring event or guarantee interior access. No festival tickets, dates or availability were verified.

The older URL `https://dinlarthelwa.org/heritage-sites/managed-heritage-sites/chapel-of-santa-marija-ta-bir-miftuh-2/` returned HTTP 404. It must not be used as the brochure's visitor link. The replacement was discovered through the custodian's current [Churches and Chapels directory](https://dinlarthelwa.org/churches-and-chapels/) and fetched successfully. This fixes an actual source-link issue before publication.

## Everyday services

| Need | Verified source fact | Safe editorial use |
| --- | --- | --- |
| Groceries | [MyConvenience locations](https://my.mt/locations/) lists Gudja 1 at **56 Vjal it-Torri, Il-Gudja**. Its airport SkyParks shop is a separate entry. | A concrete village grocery address; link to the operator for current hours. No stock, pricing or nearest-shop assertion. |
| Community clinic | [Primary HealthCare clinics](https://primaryhealthcare.gov.mt/en/clinics/malta-community-clinics/) lists **20 William Baker Street** for Gudja. | Link to official service and appointment information; no promise of walk-in availability. |
| Health-centre catchment | [Primary HealthCare health centres](https://primaryhealthcare.gov.mt/en/health-centers/) includes Gudja in the Paola catchment. | Name the catchment and link to the official directory. Do not reproduce a Paola street address: different retrieved versions exposed inconsistent addresses. No treatment advice or static opening schedule. |

The direct Python client received 403 responses from council/healthcare pages; the official text was independently read with the web reader. MyConvenience initially failed Python's certificate validation, but a normal Node HTTPS request subsequently returned 200 with validation enabled. Neither a protection bypass nor disabled certificate validation was used. Do not misreport these client-specific results as universal site outages.

## Food addresses: classify before presenting

Both MTA queries returned HTTP 200 on 14 November: [restaurants filtered to GUDJA](https://www.mta.com.mt/licences/licences/?type=restaurants&town=GUDJA&size=250) and [snack bars filtered to GUDJA](https://www.mta.com.mt/licences/licences/?type=snack-bars&town=GUDJA&size=250). The saved table contains **two restaurant and seven snack-bar records**, not nine verified operating village venues.

| Register record | Location in the register | Treatment |
| --- | --- | --- |
| SBR-25547 — Il Patrun snack bar | Shop 1, Triq Ħal Tarxien | Potential local address example, explicitly a register listing. Current trading, menu and public opening unverified. |
| SBR-32745 — Jammin Snack Bar | Dalli Industrial Estate, Triq Ħal Tarxien, GDJ 1907 | Industrial-edge example, separate from the village core. Same current-operation limits. |
| SBR-17502 — Talbot and Bons Snack Bar | 95 Triq il-Kbira | [Operator contact page](https://talbotbons.com/contact-us/) corroborates the address but presents accommodation contact/check-in information. It does not establish a public walk-in restaurant or distinguish guest-only service. Require confirmation before wording it as a place to eat. |

The remaining six records are excluded from village-centre food suggestions: Verani `RST-31391` and Jet Express `SBR-17366` refer to departure lounges; Wagamama `RST-23078` refers to SkyParks; Burger King MIA `SBR-31526`, McDonald's Airport `SBR-12065` and Tat-Te Arrival Lounge `SBR-31645` refer to the airport context. Do not infer which are airside beyond the actual departure/arrival wording.

A licence entry is evidence of a register record, not current trading, rating, cuisine, price, reservation availability or a partnership. Publish this section as a small, honest address guide unless additional operator evidence is obtained. No menus or generic promotional descriptions were invented, and no owner was contacted.

## Transport and lightweight map

The actual stop lists, not the site-wide stop selector, support these route examples:

| Operator route | Checked connection | Gudja stop evidence |
| --- | --- | --- |
| [88](https://www.publictransport.com.mt/route/88/) | Valletta — Gudja — Airport | Gudja **1637**, with Annunziata 1635 and Ciru 1636 nearby in the route list. |
| [135](https://www.publictransport.com.mt/route/135/) | Mater Dei — Marsaskala | Gudja **1637** in the route's own timetable list. |
| [226](https://www.publictransport.com.mt/route/226/) | Mater Dei — Gudja | Gudja **1637** towards Gudja; **6407** for the departure from Gudja towards Mater Dei. |

The provider pages also expose a network-wide selector containing similarly named Gozo stops. Those are not evidence for a Gudja, Malta route. Do not copy timetables into the brochure or imply a fixed connection from an individual property. Users should check the linked route and service alerts for their travel day.

The saved [Nominatim result](https://nominatim.openstreetmap.org/search?q=Gudja%2C+Malta&format=jsonv2&limit=1) is OSM relation **7510557**, named Il-Gudja, Southern Region, Malta: latitude **35.8483258**, longitude **14.5030882**. Its returned extent is latitude `35.8387313–35.8591452`, longitude `14.4945518–14.5119863`.

For a later click-to-load 2D map, initial candidate bbox in longitude/latitude order is `14.4945518,35.8387313,14.5119863,35.8591452`. It is orientation only, not a surveyed municipal boundary, property marker, entrance or recommended route. Verify the visible framing on a real mobile preview before adoption. Do not generate walking geometry from that extent. Any future ferry continuation must remain a separately sourced transport leg; no ferry leg is proposed for this inland village.

## Photograph selected and licensed; brochure preview still pending

`gudja-image-candidates.json` retains the initial six-candidate metadata shortlist: one parish view, four generically captioned Gudja views and one Bir Miftuħ façade. Each has the exact source page, original URL, author, date, licence URL, dimensions, size and Commons SHA-1. The generic filenames do not prove a specific street or suitability. A fireworks search hit was rejected as a poor everyday orientation image, without downloading it.

The separate asset step used a fresh `origin/main` worktree at `D:\2906\nexus-bridge-work\20261114\gudja-asset`, branch `travel/gudja-asset-20261114`, carrying completed travel/research work to pre-edit HEAD `16ef1dcbf5eadcb9da751844e2b5483a6548e866`. Four originals were downloaded and inspected. All four match Commons SHA-1 and byte counts and decode completely. The parish JPEG stores a rotated pixel matrix with EXIF orientation 6; its displayed 1936 × 2592 dimensions match Commons. The initial encoded-dimension check was corrected to validate displayed dimensions, not ignored.

Selected: Continentaleurope's **Parish Church of the Assumption**, 7 May 2017, CC BY-SA 4.0. The church subject and Gudja attribution are supported by the Commons source page, its Gudja Parish Church category, camera location and visual comparison with the council's parish context. The full portrait preserves the façade and surrounding benches; no identifiable person, plate or private contact was observed. `assets/gudja-parish-continentaleurope.webp` is 1200 × 1607, 215,896 bytes, SHA-256 `65a4c1902280ab3696c19f81051b101924eb6f5cbce1e0273b6afad230f4d8aa`. The source's display orientation was applied before proportional resize/WebP conversion, without crop, retouch or generative change. The derivative was fully decoded and visually inspected.

The Bir Miftuħ original is a dark night view and was not selected for daylight orientation. Gudja 06/08 depict a building beyond fields and walls; they were correctly rejected as unverified building/access context, not used as street images. Gudja 07/11 remain undownloaded. Exact decisions and original/output hashes are in `gudja-image-audit.json`; visible credit/alt/caption templates are in `gudja-image-credits.md`. Historic imagery must not imply today's parking, traffic, business operation, property views or access conditions. The approved asset is private under `docs/`; no photo is published yet.

## Evidence and next verification gates

- `gudja-source-evidence.json`: direct-fetch times, response status, byte counts and hashes; separately identified web-reader evidence; route excerpts; precise airport exclusions; source limitations.
- `gudja-image-candidates.json`: original metadata shortlist. `gudja-image-audit.json` is the subsequent selection authority; `gudja-image-credits.md` supplies visible attribution requirements.
- Raw source files and collection helpers: `D:\2906\nexus-bridge-work\artifacts\20261114-gudja-research`, outside Git and outside `public/`.
- Completed route regression results from the research session are retained; no route code changed. JSON parsing, raw-source hash comparisons and diff checks are the relevant checks for this documentation step. No browser preview, mobile rendering or application build is claimed.
- Next create a private, noindex brochure preview using the approved portrait, substantial local copy, readable attribution and a deferred map. Verify 360, 390, 430px and desktop, keyboard access, no-JS fallback and no initial external map load. Full image framing in real responsive pages remains untested.
- Only after preview verification prepare canonical/social metadata, a single sitemap entry and contextual inbound links. Before publication recheck mutable sources and actual release pointers, use the existing guarded www-only release process and retain rollback. No blanket deployment from this research branch.

No public page, navigation, sitemap, production alias, external backlink, account, WhatsApp, outreach, scheduler, payment, database or NEXUS functionality changed in this step.

## Private brochure preview verified, 14 November 2026

The independent English `gudja-preview.html` and local `gudja-preview.css` are private under docs. They reuse the approved complete portrait, distinguish village/industrial/airport contexts, retain exact source links and MTA references, and load an orientation-only OSM map on explicit request. No canonical, public sitemap entry or public route was added.

Actual browser tests passed at 360, 390, 430px and 1440px: no overflow, one H1, noindex/nofollow, image decoded at 1200×1607 with full proportional framing and visible dated licence attribution, working keyboard skip/map controls, zero initial external requests, exactly one loaded OSM canvas with attribution after activation, idempotent loading, no browser/request errors, and a no-JavaScript link fallback. Desktop hero, mobile portrait and real mobile map were visually inspected. Twenty screenshots and the test helper are retained outside Git; hashes and exact results are in `gudja-preview-verification.json`.

Next: prepare a narrow release candidate with canonical/social metadata, sitemap and contextual inbound link. Before any deployment, verify current production again and transfer only the Gudja delta onto that snapshot. The newer `/nexussecret` presentation was independently published from commit `eafabeb` on 14 November; this travel branch does not contain it and must never replace that application wholesale. No new live-pointer check is claimed for this private preview step.
