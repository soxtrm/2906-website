# NEXUS BRAIN V2 — release verification

Status: **LIVE, PRIVATE / ADMIN-ONLY** at https://nexuslink.fit/rating. No public menu or sitemap entry.

Frontend source commit: `ccaee3683199305e42953245603e2e025fa481cf`.
Branch: `feat/nexus-brain-v2-20261113`.
Vercel deployment: `dpl_HieiFX5fazgf1cKrtch7WEetzfwP`.
Pinned upstream: `2906-website-6zbi-78rmp8s7v-kevinsony1-9794s-projects.vercel.app`.
Vercel READY confirmed. Existing 2906/CRM production aliases remain on `2906-website-6zbi-33h2ntair-kevinsony1-9794s-projects.vercel.app`; no global promotion was performed.

## Actual release

The existing Caddy host activated the four scoped paths at **2026-11-13 23:06:59 UTC / 14 November 00:06:59 Malta**. Caddy and nexus-booking both remain active.

- Before config SHA256: `6bdf8a77d0a487ec6ee6ecef112e9e264fa151994424b0ad103d6f1c8f61e873`
- After config SHA256: `5271fe469c23459ead71edc31284258a17f711b369210e8f64ebe5983834d7a7`
- Exact backup: `/etc/caddy/Caddyfile.before-nexus-brain-20261113T230659Z`
- Vercel protection remains enabled. The existing server-side automation credential is not included in source, browser output, evidence or this report.
- Canonical dirty checkout remains at `c0dfe76151452fb224845e578464d19b0700e23a`; this task made no edits there.

## Test evidence

| Verification | Result | Evidence |
|---|---|---|
| Production build | PASS | Next 16.2 webpack build, 56 static pages, dynamic `/rating` and `/rating/session`; remote Vercel build also READY |
| Behavioral unit tests | 5/5 PASS | `node --test tests/nexus-brain.test.mjs`, all 101 rating positions + raw 9.4999 boundary; extreme observations, modes, semantic branches, unknown FIT |
| Production-build browser checks | 31/31 PASS | `test-results.json`; headless Chrome 147; HTML/RSC auth failures, all modules, reduced motion, touch and keyboard, desktop + 390/430px |
| Live HTTPS checks | 12/12 PASS | `live-results.json`; anonymous/invalid HTML and RSC locked; identity reachable; missing login credentials rejected without session; mobile/desktop login assets load |
| Existing public site | PASS | `/`, `/anima`, `/robots.txt`, `/sitemap.xml` HTTP 200; no `/rating` link added |
| Platform protection | PASS | Direct deployment remains Vercel-protected; external bypass-cookie query rejected HTTP 400; application session gate remains required |
| Runtime errors | None observed | Browser pageerrors empty; Vercel error log query 22:51–23:11 UTC returned zero records |
| Real mutations | None | Interactive suite observed zero POST/PUT/PATCH/DELETE requests; live smoke submitted only `{}` to login and received rejection |
| Repo typecheck | Existing issue remains | `lib/crm/ui.tsx:446` ownerquality/NavKey error predates this feature; no new-page errors. Existing build setting skips typecheck |
| 21st design review | 0 errors | Three informational palette warnings; custom navy/gold/mint art direction documented |

Local role fixtures are deliberately separate from live identity. **A successful live login with the founder's actual admin credentials was not performed.** No password/session was requested, harvested or changed. The complete authorized interaction suite uses the real production build with a loopback identity service; live checks independently prove the protected route and canonical login are reachable. Access: open the URL and use the existing ARGUS admin username/email and password.

## Performance sample

390px touch viewport; Chrome on this Windows desktop, not a physical-device benchmark. A cold-cache run at 4× CPU slowdown, 1.6 Mbps down and 150 ms latency measured DOMContentLoaded **1,339 ms**, load **3,621 ms**, tap-to-next-frame **27 ms**, JS heap **7.7 MiB**, decoded script bytes **601,338**. No WebGL/canvas context. The unconstrained host's median frame interval was 4.2 ms (high-refresh headless host; do not present it as phone FPS). Motion stops offscreen/background and reduced motion is honored. Physical Android/iPhone GPU verification remains unperformed.

## Screenshots and walkthrough

All files are in `D:/2906/nexus-bridge-work/20261113/nexus-brain-v2/tests/screenshots/nexus-brain-v2/`:

- `desktop-hero.png`, `desktop-burgers.png`, `desktop-time-delta.png`
- `desktop-rating-9-5.png`, `desktop-semantic.png`, `desktop-merchant-loop.png`
- `mobile-390-hero.png`, `mobile-390-burgers.png`, `mobile-390-rating.png`, `mobile-390-merchant.png`
- Corresponding `mobile-430-*` screenshots
- `mobile-walkthrough.webm` (1,163,946 bytes)
- `live-signin-1440.png`, `live-signin-390.png` — actual HTTPS production page

The presentation screenshots/video show the local production build with fictional authorized identity. The live-signin screenshots show the deployed HTTPS route. They are not mislabeled as a real founder login session.

## Scope and readiness

The food orbit, expected/delivered imagery, wait timeline, service-specific radar, immutable history, rating input, branching feedback, FIT, opt-in friend examples, merchant return loop and vertical teasers are implemented. All demo state resets on reload; no real scoring or merchant data pipeline is claimed. Underlying global ARGUS/booking/3D interactions remain untouched. No real messages or payment operations occurred.

The only operational dependency is the existing ARGUS admin identity service and the server-held Vercel automation credential. Identity failure locks access. The page is usable for private founder presentations; a real ratings engine, physical-device benchmarks and arbitrary external presenter account provisioning are outside this release.
