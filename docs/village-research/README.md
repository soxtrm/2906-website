# Malta village editions — editorial checkpoint

Status: Seven English editions are published: Sliema, St Julian's, Swieqi,
Tal-Ibraġ, Madliena, Pembroke and Mosta. The older `swieqi-preview.html` is retained
only as an archival draft and is not the public release.

Included: Swieqi / Tal-Ibrag / Madliena comparison, separate Pembroke treatment, licensed archival panorama, Greens weekly shop, Drift and The Greenhouse operator-sourced listings, council-sourced heritage, click-to-load OSM area overview.

Verified: 390px and 1440px layouts without horizontal overflow; one primary heading; image decoded; noindex. OSM embed returned HTTP 200 and its mobile rendering and attribution were visually reviewed. Venue details have source/date links, no rankings or invented journey times.

Before release:
- Review the complete page visually on both sizes after final copy changes.
- Add navigation to the existing 2906 editions and housing product.
- Set the actual public URL and canonical/description/social metadata only when publishing; remove draft notices then.
- Register the finished edition in the existing discovery and sitemap paths.
- Keep district/venue pins omitted until independently verified. The broad overview already works and must not be mistaken for district boundaries.
- Preserve photograph credit, CC BY-SA 4.0 link and archival date.

Do not repeat earlier image/venue research: sources and licensing are in swieqi-cluster.md. No external backlink has been published for this edition.

## Publication update — 29 September 2026
Swieqi is now published in English at https://www.2906.estate/link-marketplace/areas/swieqi.html (commit2d3d3c8, production HTTP200). The local preview remains an archival draft. Navigation, canonical, description and sitemap completed. Detailed pins remain omitted. Next independent edition: Pembroke; see pembroke-research.md.

Pembroke is published at https://www.2906.estate/link-marketplace/areas/pembroke.html (commit `1a11ab4`, production HTTP 200 verified on 30 September 2026). Its research record and editorial draft remain in this folder.

Tal-Ibraġ is published at https://www.2906.estate/link-marketplace/areas/tal-ibrag.html (commit `11cd13b`, production HTTP 200 verified on 4 October 2026). Its evidence boundary remains recorded in `ta-ibragg-research.md`; the edition stays distinct from the wider Swieqi overview.

Madliena is published at https://www.2906.estate/link-marketplace/areas/madliena.html (commit `c85a1c6`, production HTTP 200 verified on 4 October 2026). Its terrain-led evidence and explicit everyday-services gap remain recorded in `madliena-research.md`.

Swieqi, Tal-Ibraġ, Madliena and Pembroke now cross-link directly between their editions (commit `f29aa36`, production HTTP 200 verified on 4 October 2026). No external backlink has been published for these editions.

Mosta is published independently at https://www.2906.estate/link-marketplace/areas/mosta.html (commit `9608efa`, production HTTP 200 verified on 9 October 2026). Its sourced dossier is `mosta-research.md`; the edition separates the Rotunda-centred core from the wider everyday retail radius and does not claim a generic commute time.

Naxxar is prepared as a separate release candidate at `/link-marketplace/areas/naxxar.html`. Its sourced dossier is `naxxar-research.md`; the edition keeps the Victory Square core distinct from the much larger council territory. Mobile/desktop, image, metadata and click-to-load map checks passed locally on 9 October 2026. Production status remains pending until the deployment is verified live.
