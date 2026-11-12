# ARGUS Outreach date/list-state production deploy — 2026-11-13

Status: **DEPLOYED AND LIVE-VERIFIED**. No real message was sent and no
outreach plan, account setting, queue entry, or production row was changed by
the verification.

## Backend

- Reconciled the two changes onto the actual production files instead of
  replacing them with the stale repository mirror.
- `services/outreachPlanner.js` production MD5:
  `6a2483dbafee99ae7da31532534973b3`.
- `routes/crm.js` production MD5:
  `0fe763586accabd4edef526aa3efb4a5`.
- Live `/health`: HTTP 200; unauthenticated plans route: HTTP 401.
- Rollback backup:
  `/opt/2906-system/backups/outreach-ui-20261113-20261112T234102Z`.
- Deployment input and guarded rollback script:
  `/opt/2906-system/deploy-inputs/outreach-ui-20261113/argus-outreach-ui-20261113`.

## Frontend

- Vercel production deployment: `dpl_7fS8aK1R7hU73VrmhKkyqXHpLPbB`.
- Production URL: `2906-website-6zbi-lqnsfi7w2-kevinsony1-9794s-projects.vercel.app`.
- Active aliases include `crm.2906.estate`, `2906.estate`, and
  `www.2906.estate`.
- Previous production deployment retained for rollback:
  `2906-website-6zbi-avh3qju26-kevinsony1-9794s-projects.vercel.app`.

## Verification

- Next.js production build with webpack: pass, 54 static pages generated.
- Browser acceptance against the built local release: 3/3 pass at 1440, 390,
  and 360 pixels.
- Browser acceptance against `https://crm.2906.estate`: 3/3 pass at 1440,
  390, and 360 pixels. CRM API responses were stateful synthetic fixtures, so
  the test could exercise saving, conflicts, account switching, list locks,
  and templates without touching production data or sending WhatsApp messages.
- The browser test now waits for the intentional cold-load ARGUS intro to
  finish before tapping mobile account cards and scrolls the actual target
  card into view.

## Scope

This release shows real provider-accepted outreach dates in Malta time and
guides list generation around scheduled/running/completed/cancelled plans with
an actionable HTTP 409 instead of a generic server error. It does not enable
automatic outreach or change saved pace/Auto/Pause values.
