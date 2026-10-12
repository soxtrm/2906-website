# Current traffic corridor inventory

Verified from the production current snapshot generated at `2026-10-12T01:47:42.871Z`. These are directional routes between public anchors. They are not individual street segments and do not represent all Malta roads. The Google response field mask contains no polyline, so actual street-by-street geometry coverage is unavailable.

| Directional corridor | From | To | Current route length |
| --- | --- | --- | ---: |
| `airport--central-birkirkara` | Airport | Central Birkirkara | 7,171 m |
| `airport--south-marsaskala` | Airport | South Marsaskala | 11,764 m |
| `central-birkirkara--airport` | Central Birkirkara | Airport | 7,959 m |
| `central-birkirkara--ta-qali` | Central Birkirkara | Ta' Qali | 4,150 m |
| `cirkewwa--north-mellieha` | Ċirkewwa | North Mellieħa | 5,513 m |
| `cirkewwa--st-julians` | Ċirkewwa | St Julian's | 25,384 m |
| `mdina-gate--north-mellieha` | Mdina Gate | North Mellieħa | 15,737 m |
| `mdina-gate--sliema` | Mdina Gate | Sliema | 12,536 m |
| `north-mellieha--cirkewwa` | North Mellieħa | Ċirkewwa | 5,749 m |
| `north-mellieha--mdina-gate` | North Mellieħa | Mdina Gate | 16,015 m |
| `portomaso--sliema` | Portomaso | Sliema | 2,826 m |
| `portomaso--st-julians` | Portomaso | St Julian's | 1,573 m |
| `sliema--mdina-gate` | Sliema | Mdina Gate | 13,260 m |
| `sliema--portomaso` | Sliema | Portomaso | 3,392 m |
| `sliema--valletta-gate` | Sliema | Valletta Gate | 7,071 m |
| `south-marsaskala--airport` | South Marsaskala | Airport | 11,535 m |
| `south-marsaskala--ta-qali` | South Marsaskala | Ta' Qali | 16,389 m |
| `st-julians--cirkewwa` | St Julian's | Ċirkewwa | 24,518 m |
| `st-julians--portomaso` | St Julian's | Portomaso | 919 m |
| `st-julians--valletta-gate` | St Julian's | Valletta Gate | 8,255 m |
| `ta-qali--central-birkirkara` | Ta' Qali | Central Birkirkara | 4,186 m |
| `ta-qali--south-marsaskala` | Ta' Qali | South Marsaskala | 15,946 m |
| `valletta-gate--sliema` | Valletta Gate | Sliema | 5,880 m |
| `valletta-gate--st-julians` | Valletta Gate | St Julian's | 6,811 m |

All 24 use `Google Maps` as the provider identity. Opposite directions are intentionally distinct and often differ in length. No duplicate directional key exists. Some routes overlap on the road network, but overlap cannot be quantified without provider geometry.

## Collection volume

One alternating batch contains 12 directional requests. At an exact 15-minute cadence this is 96 runs and 1,152 route requests per day, or 34,560 requests in a 30-day month. The two-batch cycle refreshes each of the 24 directional corridors approximately every 30 minutes.

## Expansion plan

No expansion is deployed. A compliant source should first map stable directional road segments for major arterials, commuting corridors, junction connectors, airport and ferry routes, the Sliema–St Julian's–Gżira–Valletta core, then central, north, south, and finally lower-volume local roads.

| Planning tier | Directional segments | Queries / 15 min | Queries / day | Queries / 30 days |
| --- | ---: | ---: | ---: | ---: |
| Pilot | 48 | 48 | 4,608 | 138,240 |
| Core network | 120 | 120 | 11,520 | 345,600 |
| Broad network | 250 | 250 | 24,000 | 720,000 |

Monetary cost remains blocked until a provider whose licence permits historical storage, derived profiles, and Nexus/Mapbox rendering is selected. Batch or matrix endpoints may reduce billable elements, but that is provider-specific and must be priced before approval.
