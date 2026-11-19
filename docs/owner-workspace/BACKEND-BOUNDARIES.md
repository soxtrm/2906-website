# SYNC. ↔ ARGUS: existing routes and ownership boundaries

Read from the live ARGUS backend on 19 Nov 2026 (read-only). This replaces the
"new tables" part of BACKEND-HANDOFF.md: most of what SYNC needs already exists
as the NEXUS link layer. Nothing was changed on the server.

## 1. Who owns which data

| Data | Owner (canonical) | Tables | SYNC may |
|---|---|---|---|
| Owner identity, phones, emails, notes, do-not-contact | ARGUS | `owner_contacts`, `owner_phone_variants`, `owner_privacy_requests` | read a whitelisted view only; never internal notes, summaries, outreach counters |
| Properties | ARGUS | `properties`, `property_viewings`, `property_calendar_blocks`, `property_viewing_windows` | read via the link read API; changes go as proposals |
| Owner ↔ NEXUS account link | ARGUS (per agency) | `nexus_owner_links` (`agency_key`, `owner_contact_id`, `nexus_account_ref`, `link_state`, `verified_at`, `verification_method`) | request a claim; never self-verify |
| Property claims by an owner | ARGUS | `nexus_owner_property_claims` | create claims, see decisions |
| Owner-proposed listing changes | ARGUS review | `nexus_owner_property_updates` (`fields`, `review_state`, `reviewed_by_agent_id`) and agent-side `property_pending_changes` | submit versions; agent approves |
| Owner answers (availability etc.) | ARGUS | `nexus_owner_answers` | submit, withdraw |
| Owner viewing hours | ARGUS | `nexus_owner_viewing_schedules` | submit versions |
| Distribution to agencies | ARGUS | `nexus_distribution_routes`, `nexus_distribution_grants` | grant or revoke scopes, only with a verified link |
| Invitations | ARGUS | `nexus_owner_invitations` (hashed token, expiry, single use) | resolve a token into a claim |
| Events ARGUS → NEXUS | ARGUS | `nexus_sync_outbox` (idempotency key, payload hash, retries) | consume |
| Events NEXUS → ARGUS | ARGUS | `nexus_inbound_events` (dedup by `event_id`) | send |
| Owner documents | ARGUS | `owner_documents` | upload through a reviewed path |
| Owner tenant wishes | ARGUS | `owner_tenant_preferences` | propose; protected traits never stored |
| **SYNC login identities and sessions** | **NEXUS Sync (new)** | `sync_accounts`, `sync_identities`, `sync_sessions`, `sync_phone_checks` | own fully; `sync_accounts.id` is the `nexus_account_ref` |

Agency tenants: every NEXUS table carries `agency_key`. ARGUS reads its own from
`ARGUS_AGENCY_KEY` (default `2906`). Benestates is a second `agency_key` on the
same infrastructure; no separate chat backend and no second owner system.

## 2. Existing routes to use (no new parallel routes)

**Server-to-server link (NEXUS Sync → ARGUS)**, `routes/nexusLinkService.js`, mounted at `/api/nexus-link/v1`:
- `POST /invitations/resolve` `{ token }`
- `POST /events`: the only write path (claims, updates, answers, schedules, grants), handled by `HANDLERS` in `services/nexusOwnerInbound.js`, deduplicated in `nexus_inbound_events`
- `POST /read/owner-link`, `/read/properties`, `/read/viewing-busy`, `/read/source-match`, `/read/market`

Auth: HMAC (`X-Nexus-Link-Timestamp`, `X-Nexus-Link-Signature`, key id `NEXUS_LINK_INBOUND_KEY_ID`).
**Status: dormant.** `NEXUS_LINK_INBOUND_SECRET` is not set on the live backend, so
the whole surface answers 503. Setting it (32+ characters, shared with the SYNC
server, never in the browser) is the switch.

Browsers never call this API. The SYNC frontend talks to a small SYNC server
(Next.js route handlers on nexussync.one, or a NEXUS service). That server holds the
session and signs calls to ARGUS.

**Agent side (already in the CRM)**, `routes/crmOwnerNexus.js` at `/api/crm/owner-nexus`:
- `GET /:ownerId` status; `POST /:ownerId/invitation`, `/invitation/copy`, `/invitation/revoke`
- `POST /:ownerId/verify`, `/dispute`, `/dispute/resolve`: **agent confirms ownership here**
- `POST /:ownerId/sync-owner`, `/sync-properties`, `/retry`
- `GET|PUT /property/:propertyId/route`, `/route/approve`, `/route/revoke` for distribution and exclusivity

**Link states** (`nexus_owner_links.link_state`): `not_invited` → `invited` → `claim_pending` (account attached) → `verified` (agent, with `verification_method`), or `disputed` / `revoked`.
Distribution and availability confirmation require `verified`.

## 3. How SYNC verification maps onto this

1. Owner signs up in SYNC (email/password or Facebook) → `sync_accounts`.
2. Owner confirms the phone by WhatsApp ("SYNC verify CODE" to ARGUS Main) or SMS → `sync_accounts.phone_confirmed_at`.
3. SYNC server sends a `claim` event: ARGUS matches the phone against `owner_contacts.phone_normalized` and `owner_phone_variants`. On a match, ARGUS sets `nexus_owner_links.nexus_account_ref` and `link_state = 'claim_pending'`. **No access yet.**
4. An agent sees the claim in the CRM and calls `/api/crm/owner-nexus/:ownerId/verify` (`verification_method = 'phone_whatsapp'` or `'phone_sms'`). Only then do properties appear in SYNC.
5. An invitation token from an agent can speed this up but, as today, it only creates a claim. It never verifies on its own.

## 4. Messaging: what exists and the gap

- WhatsApp inbound arrives at `POST /webhook/waha` (`routes/webhook.js`, internal only). It routes by session (`lib/sessionRouter.js`), with admin commands, uploads, availability, rented detection and reply classification inline.
- Sending goes through `waha.js` sessions (`whatsapp_accounts`; ARGUS sessions `Argus1`–`Argus5`, Kev accounts). Outbound owner messages are logged in `owner_contact_log`.
- Client relay threads use `book_relay_threads` / `book_relay_messages`. Hot leads are marked in Chatwoot (`chatwootService.markHot`).
- **There is no canonical owner chat table.** The WhatsApp chat in WAHA is the record.

Proposal for the SYNC chat, with no second chat backend:
- SYNC → ARGUS: a new inbound event `owner.message` via `/api/nexus-link/v1/events`. ARGUS writes it to `owner_contact_log` (`kind = 'sync_inbound'`, `is_mine = false`) and shows it in the owner's thread in the board, the same place as WhatsApp replies.
- ARGUS → SYNC: agent and system replies to a verified SYNC owner go out as `owner.message` outbox events (`nexus_sync_outbox`), with the sender (agent name, agency, role).
- WhatsApp stays the fallback channel per the owner's `notify_channel`.
- The single new piece is the `sync_verify` match in `/webhook/waha` (step 2), placed before AI and lead handling, for the ARGUS Main session only.

## 5. Open items for Kev

1. Which WAHA session is "ARGUS Main" for SYNC (for example `Argus5 Nexuslink`) and its number.
2. Setting `NEXUS_LINK_INBOUND_SECRET` and `ARGUS_AGENCY_KEY` on the live backend is a production change and needs Kev's go.
3. Meta: add Facebook Login with redirect `https://nexussync.one/api/auth/facebook/callback`. The callback lives on the SYNC server because it holds the sessions.
4. SMS provider, or email codes as the first fallback.
