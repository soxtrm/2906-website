# NEXUS private preview on 2906.estate (16 Nov 2026)

Kevin asked for this ("On 2906.estate", behind a path, not on the main page), so that ChatGPT can open the NEXUS preview.

- **URL:** https://www.2906.estate/private-preview (noindex, nofollow, noarchive).
- **Change:** commit `9386d21` on `claude/private-preview-route-20261116`, built on the live travel release `0f8ede6` (Il-Hamrun).
  - `next.config.mjs`: `beforeFiles` rewrites forward these paths to https://nexuslink.fit:
    - `/private-preview`
    - `/preview-f100547a49/*`
    - `/api/nexus-booking/*`
    - `/NexusBooking/*`
    - `/node_modules/three/*`
  - `proxy.ts`: the i18n matcher skips those paths.
  - Nothing else on the 2906 site changed.
- **Production deployment:** `2906-website-6zbi-kr478boq3-kevinsony1-9794s-projects.vercel.app`, deployed with the CLI from a clean worktree of `0f8ede6` plus `9386d21`.
- **Previous production** (the rollback target): `2906-website-6zbi-q80ietiu2-kevinsony1-9794s-projects.vercel.app`. Before deploying I checked that this was still the production deployment.

## Verified

- **On the Vercel preview, before production:**
  - The new paths answer 200.
  - `/en`, `/en/travel` and `/link` answer exactly like production: 307, 307 and 200.
- **On production, after the deploy:**
  - `/private-preview`, the 3D map, the NEXUS booking API and `/` answer 200.
  - `/crm` is still 404 publicly.
  - `2906.estate` still redirects to `www`.
  - A browser check showed the home page and the Spatial map.

## Important for the next 2906 release

Resolve the live Vercel alias before building the next travel release. At the 16 November handoff, `www.2906.estate` resolved to `dpl_DWAWZbpxfJYydLR5y2mMMjXyTQpS` at source commit `9386d21`. Build on the verified live source and carry in the travel-only delta. Verify `/private-preview` and the spatial map on the candidate and again on www after assignment. Both should return the NEXUS page and its `X-Robots-Tag: noindex, nofollow, noarchive` header. A successful anonymous response and the robots header establish an unlisted link, not an authentication boundary.

## Roll back or remove

- **Roll back a travel-only release:** use its guarded www-only alias assignment and restore the deployment it actually displaced. Verify the other aliases before and after.
- **Remove the preview deliberately:** revert `9386d21` on top of the current release and verify the intended alias scope before publishing.
