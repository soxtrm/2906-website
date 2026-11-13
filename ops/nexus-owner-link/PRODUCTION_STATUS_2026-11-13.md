# ARGUS × NEXUS owner link production status — 2026-11-13

## Deployed

- The 2906 CRM owner-profile NEXUS tab is deployed from `main` at commit
  `5fb7341` through Vercel deployment `dpl_6kJZwZ99zeodiBaPJ74y9Wh5Y6jr`.
- Production serves the owner-profile bundle from `https://crm.2906.estate`.
- The ARGUS owner-link routes, services, and additive tables are present in the
  production backend. Unauthenticated staff access returns HTTP 401.
- The signed service endpoint fails closed with HTTP 503 while its directional
  secret is unset. The owner-link scheduler remains disabled.
- No owner invitation, WhatsApp message, release, or external distribution was
  created by this deployment.

## Verified

- Next.js production build: pass (54 routes).
- Owner-profile NEXUS UI: Chromium pass at 1440, 390, and 360 CSS pixels.
- Hosted integration gate recorded by the release: 12/12.
- Production ARGUS tables present: `nexus_owner_links`,
  `nexus_distribution_routes`, `nexus_owner_property_updates`,
  `nexus_owner_viewing_schedules`, and `nexus_owner_answers`.
- Existing NEXUS ONE v101 remains active at
  `/opt/nexusbooking/releases/20261112-nexus-one-v101`; public home, auth status,
  and booking config probes return HTTP 200. Its retained rollback is v100.

## Activation blocker

The NEXUS Housing receiver is not activated. Production has no configured
`NEXUS_HOUSING_DB_DSN`, `NEXUS_HOUSING_ARGUS_READ_DSN`, directional bridge
secrets, or Housing feature flags, and the repository is not linked to a
Supabase project. Activating links without these dependencies would produce a
dead owner flow. The reviewed receiver code stays staged until a production
Housing database/project and scoped credentials are provisioned, migrated,
backed up, and verified.

