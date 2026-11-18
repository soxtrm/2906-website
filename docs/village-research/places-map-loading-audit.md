# Neighbourhood places-map loading verification

Read-only live verification on 18 November 2026, using the published Kerċem edition at https://www.2906.estate/link-marketplace/areas/kercem-gozo.html. No application changes or deployment.

Earlier full-page release screenshots show grey backgrounds beneath places markers, while the independent orientation maps show map tiles. The existing release browser check waited for the industry filters to appear, which establishes filter readiness but not completed raster imagery. This audit explicitly waited for the second map’s tile images to finish.

At 390px, all four second-map tile images were initially pending. They loaded successfully; the measured wait plus screenshot preparation was 115ms. At 1440px all fifteen second-map tile images were already loaded at the first snapshot; the subsequent check and screenshot preparation took 81ms. Those timings describe this observed run and include tooling overhead; they are not a general latency guarantee.

All recorded tile HTTP responses were 200, both completed map screenshots showed the real basemap and markers, and both pages had zero JavaScript page errors. No product loading defect was reproduced, so no change to working map logic is warranted.

For subsequent release evidence, retain the filter assertion and also wait for at least one second-map tile and all current tile images to be complete with positive natural width before capturing that map. This avoids presenting an in-flight map as the finished state. No route geometry, owner data, outreach or scheduler work is involved.

Structured evidence: `places-map-loading-verification.json`. Browser script, full results and cropped screenshots are retained in `artifacts/20261118-map-loading-audit` in the isolated worktree.
