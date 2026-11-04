# ARGUS Shared Owner History — implementation report

Date: 2026-11-04

Branch: `codex/argus-shared-owner-history-20261104`

Implementation commit: `f80594a3ee553b91a38d9e36a994626afe48d052`

Base: `98bfd10` (isolated worktree based on the existing ARGUS recovery branch)

## Root cause

The original business messages were already persisted in `book_relay_messages`. They were not made unavailable because a property lacked photos or details. The Board read path selected the current agent's latest relay thread, while the owner/profile UI did not expose a persistent conversation projection. Messages from an older, closed, or colleague-owned thread therefore looked deleted even though the durable rows still existed. A separate completeness filter made this failure look related to property data.

The fix keeps conversation status, property availability, AI state, request state, and authorization as independent dimensions. No missing messages are reconstructed or invented.

## Implemented backend and API

- Added an authorized projection over the existing `book_relay_threads` and `book_relay_messages` store; no second conversation database was introduced.
- `GET /api/crm/schedule-board/listings/:ref/owner-history`
  - returns all authorized property threads, including closed/archived history;
  - does not depend on photos or property completeness;
  - supports stable cursor pagination and redacted search;
  - returns persisted IDs, timestamps, direction, sender role, provenance, delivery state, property facts, and permitted attachment metadata.
- `GET /api/crm/owners/:id/history`
  - exposes the same persistent projection on the Owner CRM page.
- `POST /api/crm/schedule-board/listings/:ref/owner-history/actions`
  - creates internal `AWAITING_RESPONSE`, `FOLLOW_UP_REMINDER`, `REQUEST_CALLBACK`, or `ESCALATE` tasks;
  - explicitly starts no call and sends no message.
- Missing history is reported as `history_not_found`; lack of permission is `history_forbidden`. Missing property details are no longer used as a substitute error.
- Board-written messages and Board attachments now persist actor/provenance metadata.
- Reopening is tenant-scoped and authorization-checked, and changes only the conversation workflow state.

## Authorization and privacy

Access is denied before message rows are read unless the viewer belongs to the same agency and is an admin, listing/assigned agent, relay participant, viewing/request participant, owner-group requester, or availability requester for the relevant owner/property.

The shared response is produced by a backend privacy layer. It redacts known and detected:

- owner names;
- phone numbers and WhatsApp identifiers;
- email addresses;
- private addresses;
- banking/IBAN and payment-card data;
- identity-document references.

Mixed messages retain the business statement and replace only the private fragments with explicit labels such as `[PHONE REDACTED]`. Sensitive attachments are returned only as a restricted placeholder. Business attachment metadata is returned only after the same tenant/resource authorization check. The original private row remains unchanged in the protected source store.

Potentially discriminatory clauses are removed from the shared business text and replaced with `[RESTRICTED — COMPLIANCE REVIEW]`; they are not turned into matching criteria.

## Persistence migration

Migration: `backend/migrations/20261104_shared_owner_history.sql`

- Adds agency ownership to the existing agents, owners, properties, and relay threads.
- Backfills existing 2906 records and provides a tenant-aware default for new ingestion.
- Adds sender/actor/AI/provenance/attachment metadata to existing relay messages.
- Adds an insert trigger so future incoming messages retain owner role and source provenance.
- Adds the internal `owner_conversation_tasks` table.
- Adds an unprivileged `argus_history_api` database role with only the required grants.
- Includes a rollback migration.

The migration has not been applied to production.

## Agent UI

The reusable Shared Owner History interface is integrated in:

- the existing Property/Board conversation dialog;
- active client/owner-group requests via **View Owner History**;
- the Owner CRM page via **Owner Conversation**.

It provides chronological bubbles, date separators, incoming/outgoing distinction, human/AI/system sender labels, timestamps, visible redaction labels, permitted attachments, source-linked property facts, search, older-history pagination, and mobile layouts. Closed history remains visible.

## Verification

Targeted regression suite: **31/31 passed**.

Covered: two active requests, incomplete property, closed conversation, reload persistence, second authorized agent, cross-tenant denial, name/phone/email redaction, mixed business/private text, business vs sensitive attachments, persisted Board messages, discriminatory-content restriction, and no-send/no-call follow-up actions.

Additional checks:

- TypeScript: passed (`npx tsc --noEmit`).
- Next.js 16.2 production build: passed (52 routes/pages generated).
- Desktop 1440×1100 and mobile 390×844: passed with zero browser-console errors.
- Diff whitespace check: passed.
- Full backend suite: 48 passed; 50 database-backed tests could not start because the repository's test hostname `argus-outreach-testdb` is not resolvable in this worktree environment. Every observed failure had the same `getaddrinfo ENOTFOUND` setup error; the focused non-DB and contract tests passed.
- Lint remains unavailable because the repository's `eslint` script references a package that is not installed in the project.

## Visual evidence

- Before/current agent-scoped chat: `evidence/2026-11-04/owner-chat-desktop.png`
- After, shared owner history desktop: `evidence/2026-11-04/shared-owner-history-after-desktop.png`
- After, shared owner history mobile: `evidence/2026-11-04/shared-owner-history-after-mobile.png`

## Remaining limitations and deployment status

- **Not deployed.** No production migration, production API change, live message, call, or destructive data operation was performed.
- Historical attachments without an existing authorized durable URL are shown as unavailable; they are not manufactured or fetched from an unverified source.
- Older outgoing rows without trustworthy actor provenance are labeled `2906 SYSTEM`, not guessed as AI or human. New Board writes and migrated future ingestion preserve provenance.
- Search is deliberately evaluated over a bounded redacted history window; pagination remains available for older rows.
- A production staging pass still needs the real database test service, migration dry-run/rollback, representative permission fixtures, and explicit deployment authorization.
