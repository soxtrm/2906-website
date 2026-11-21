# NEXUS CTO status

Generated 2026-11-21T20:20:43.749Z from live evidence by `ops/cto/cto-report.cjs` (repo claude/argus-crm-release-20261120 @ 5cfba60). Status values: NOT_STARTED, IN_PROGRESS, STAGED, LIVE, VERIFIED, BLOCKED, FAILED. A build is not an end-to-end test; staging is not production verification.

## Launch-readiness board

| Product | Feature | Founder requirement | Status | User-facing test | Remaining blocker | Workstream |
|---|---|---|---|---|---|---|
| NEXUS Marketplace | Listing grid and cards | Compact cards after the approved reference; 5 columns on wide desktop; honest availability; bathrooms '?' when unknown | **VERIFIED** | Production, 4 viewports (1920/1440/iPad 11/phone): 5/4/2/1 columns, CLS 0.001, LCP 0.66-0.95 s warm | - | lead |
| NEXUS Marketplace | Instant detail (morph, prefetch, staggered sections) | Feels instantaneous; card grows into the detail; content flies in | **VERIFIED** | Click -> sheet ~50 ms; details ~90 ms when prefetched, 300-550 ms cold; one scroll container | - | lead |
| NEXUS Marketplace | NEXUS chat on the listing (no WhatsApp numbers) | Real chat docked right, floating tab when reading on, bottom sheet on phones, draft kept | **VERIFIED** | Staging chat E2E 18/18 (right agent, unrelated agent 404, reload, second session); draft kept on iPad/phone in prod | - | lead |
| NEXUS Marketplace | Availability freshness | A cached 'Available' never beats a newer Rented/Off-Market | **VERIFIED** | Staging status change 6/6 (opened home <= 17 s, card at once, list 25 s); production status = ARGUS for all listings | - | lead |
| NEXUS Marketplace | Smart Intelligence (redesign) | Advanced, structured places, Car/Taxi/Walk, no bus, no invented times | **LIVE** | Visual check in prod (desktop, iPad, phone); real OSRM times | Founder visual acceptance pending | lead |
| NEXUS Marketplace | Direct owner upload (no Sync account needed) | Owners list directly from the Marketplace | **NOT_STARTED** | - | Not built yet | lead |
| NEXUS Marketplace | Places tab / map journey | Maps and Places consistent with the Marketplace | **IN_PROGRESS** | Places tab still links to the classic view | Not on the new React Marketplace yet | lead |
| NEXUS Rooms | Rooms inventory, 2.5D view, real booking request | Open Marketplace, pick an apartment, choose Room 2, real request via NEXUS Booking | **LIVE** | Staging E2E 27/27; production page live but no apartment in room mode yet (honest empty state) | No owner has added rooms yet | lead |
| NEXUS Deal Room | Deal Room M3 (records, stages, CRM 3 panels, client strip) | Created at the viewing request; stable id; no duplicates; stages; private notes; no fake payment | **VERIFIED** | Staging browser E2E 12/12; backend stage 100/100 | - | lead |
| NEXUS Deal Room | Documents, evidence, contract/invoice drafts, payment states | Private storage, hashes, versions, access log; drafts; states from verified events only | **LIVE** | Staging acceptance journey 19/19 (Kev 14 steps: chat -> right agent -> viewing -> Deal Room -> booking in owner hours -> client sees it -> photo + internal doc -> contract + invoice drafts -> deposit request "not received" -> timeline -> unrelated agent 404 -> iPad + phone); backend stage 81/81 incl. regressions. Production: routes live (auth/404 verified); no synthetic deal in production by design | - | lead |
| NEXUS Deal Room | WhatsApp relay | Optional relay through the existing WAHA, no number exposure | **BLOCKED** | - | Needs 2 authorised test numbers + the sender number from Kevin | lead |
| NEXUS Sync | Calendar 2.0 | Rolling 7 days, drag ranges, 30-min slots, drag requests from the side, premium touch | **LIVE** | Staging E2E 23/23 | Founder not satisfied with visual/interaction quality | lead |
| NEXUS Booking | Rooms stays engine | One booking engine; atomic conflicts whole vs room | **VERIFIED** | 4 concurrent confirms -> exactly 1 winner; unsigned 401 | - | lead |
| ARGUS / 2906 CRM | Facebook profile lock fix | No concurrent browser launches; do not disrupt publishing | **VERIFIED** | 0 failures / 0 launches after deploy; watchdog chains 6 -> 1 | Restarting the FB group backlog (paused since 17 Sep) is Kevin's decision | lead |
| ARGUS / 2906 CRM | Drafts, Reminder Due, outreach | Preserve working outreach | **LIVE** | Owned by the outreach session | - | outreach session |
| Benestates Work | St Julian's onboarding | 8 agents pending; invitations only after an authorised sender exists | **BLOCKED** | Health endpoint 200 | No Benestates mail sender credential (SendGrid of benestates.com or M365 mailbox); 2906 Gmail must not be used | BEN cloud session |
| NEXUS Marketplace | Social launch kit | Premium editorial campaign, 9 feed concepts, 3 carousels, 3 video concepts, teaser, plan | **NOT_STARTED** | - | - | lead |
| ARGUS / 2906 CRM | CTO Cockpit + status reports | Central, admin-only status with live evidence, test links and machine-readable reports | **LIVE** | crm.2906.estate/crm/cto 200 (admin), /api/cto/health live checks; report generated from Vercel/SSH/HTTP evidence | - | lead |

## Products

| Product | URL | Live deployment | Commit | Deployed | Milestone |
|---|---|---|---|---|---|
| NEXUS Marketplace | https://nexusstudios.one/marketplace | dpl_5hW7qCKtdLxEGdKpNnLnB2uYae9J | 5cfba60 | 2026-11-21 20:19 | Malta launch ~1 Dec 2026 |
| NEXUS STUDIOS | https://nexusstudios.one | dpl_5hW7qCKtdLxEGdKpNnLnB2uYae9J | 5cfba60 | 2026-11-21 20:19 | Exchange / B2B pages |
| NEXUS Sync | https://nexussync.one/owner | dpl_5hW7qCKtdLxEGdKpNnLnB2uYae9J | 5cfba60 | 2026-11-21 20:19 | Calendar finish to founder references |
| NEXUS Booking | https://nexuslink.fit | Booking release 20261121-rooms-v120 | - | - | Rooms stays engine v120 |
| NEXUS Rooms | https://nexusstudios.one/marketplace/rooms | dpl_5hW7qCKtdLxEGdKpNnLnB2uYae9J | 5cfba60 | 2026-11-21 20:19 | First real owner onboarding |
| NEXUS Deal Room | https://crm.2906.estate/crm/deal-rooms | dpl_5hW7qCKtdLxEGdKpNnLnB2uYae9J | 5cfba60 | 2026-11-21 20:19 | M5 documents + drafts, 14-step journey |
| ARGUS / 2906 CRM | https://crm.2906.estate | dpl_5hW7qCKtdLxEGdKpNnLnB2uYae9J | 5cfba60 | 2026-11-21 20:19 | Stability, Drafts, Reminder Due (outreach session) |
| Benestates Work | https://benestates.work | release e197653 | - | - | St Julian's onboarding (8 pending) |

## Health (probed at generation)

| URL | HTTP | ms |
|---|---|---|
| https://nexusstudios.one/marketplace | 200 | 316 |
| https://nexusstudios.one/api/marketplace/listings | 200 | 2622 |
| https://nexusstudios.one/marketplace/rooms | 200 | 312 |
| https://nexussync.one/owner | 200 | 365 |
| https://crm.2906.estate/crm/deal-rooms | 200 | 195 |
| https://www.2906.estate/ | 200 | 474 |
| https://nexuslink.fit/ | 200 | 185 |
| https://api.2906.estate/api/properties | 200 | 206 |
| https://benestates.work/api/ben/work-health | 200 | 172 |

## ARGUS backend packages (latest first)

- deal-rooms-m5 · 20261121T201238Z
- reminder-pd3c · 20261121T191521Z
- reminder-pd3b · 20261121T191154Z
- reminder-pd3 · 20261121T191056Z
- deal-rooms-update · 20261121T183401Z
- deal-rooms · 20261121T182825Z
- fb-profile-lock · 20261121T181926Z
- reminder-pd2 · 20261121T181814Z
- reminder-pd1b · 20261121T180554Z
- reminder-pd1 · 20261121T180431Z
- reminder-u6f · 20261121T174408Z
- reminder-u6e · 20261121T173008Z

## Next actions

- **NEXUS Marketplace · Listing grid and cards:** Founder review against the right-hand card reference
- **NEXUS Marketplace · Smart Intelligence (redesign):** Founder review
- **NEXUS Marketplace · Direct owner upload (no Sync account needed):** Scope after Deal Room M5
- **NEXUS Marketplace · Places tab / map journey:** Port Places into the React Marketplace
- **NEXUS Rooms · Rooms inventory, 2.5D view, real booking request:** Onboard the first real owner apartment
- **NEXUS Deal Room · Deal Room M3 (records, stages, CRM 3 panels, client strip):** M5 documents/evidence, contract + invoice drafts, payment request states
- **NEXUS Deal Room · Documents, evidence, contract/invoice drafts, payment states:** Owner side in the Deal Room (Client<->Owner, Agent<->Owner) via NEXUS Sync; Anti-Fraud Bridge checks
- **NEXUS Deal Room · WhatsApp relay:** Waiting for test numbers
- **NEXUS Sync · Calendar 2.0:** Rework UI against the founder's references (backend unchanged)
- **Benestates Work · St Julian's onboarding:** Kevin pastes the sender secret in the admin form
- **NEXUS Marketplace · Social launch kit:** After the Deal Room journey
- **ARGUS / 2906 CRM · CTO Cockpit + status reports:** Screenshots per release in the cockpit
