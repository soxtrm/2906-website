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

The travel releases deploy production from their own worktrees. **A release built without `9386d21` removes `/private-preview` again.** Cherry-pick `9386d21` onto the next release branch, or rebase the release on this branch.

## Roll back or remove

- **Roll back:** run `npx vercel promote 2906-website-6zbi-q80ietiu2-kevinsony1-9794s-projects.vercel.app`, or deploy the next release without `9386d21`.
- **Remove the preview:** revert `9386d21`.
