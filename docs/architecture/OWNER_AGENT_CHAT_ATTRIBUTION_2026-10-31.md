# Owner ↔ agent chat attribution (2026-10-31)

**Question it answers:** who contacted this owner, under which WhatsApp account, who wrote last, did the owner reply, and is anyone handling the chat right now?

## Sources (metadata only, never message text)
| Concept | Source |
|---|---|
| Accounts that talk to the owner | `owner_account_labels` (one row per account: created_at, last_we_sent_at / last_outreach_at, last_reply_at, message counts) |
| Person behind an account | `agents.whatsapp_session` if an agent is bound to the account, else `whatsapp_accounts.account_persona` (kev → Kevin, cedric → Cedric, gabriela → Gabriela, olga → Olga, jasmine → Jasmine), else **UNKNOWN** |
| Initiator ("Contacted by") | the account whose conversation started first (label `created_at`) |
| Last message by / last owner reply | latest outbound / inbound timestamps across accounts |
| Assigned handler | `owner_contacts.assigned_*`, set only by an audited assignment (`POST /api/crm/owners/:id/assign`, admin), history in `owner_assignment_events` |
| Handling now | only a real stand-down from `ownerSendGate.getStandDownReason` (active board relay, a human typing on the account, owner-assistant HUMAN_ACTIVE, all with a TTL). An old outgoing message never counts |
| New chat started | `owner_chat_events` (`new_owner_chat`), written by a trigger on `owner_account_labels` insert, so no sending path can skip it |
| Identity conflict | two different persons wrote to the owner within 30 days |

Status chip: `agent_action_needed` (owner wrote last), `human_takeover`, `bot_responding`, `awaiting_owner`, `no_response` (> 7 days), `resolved`, `unknown`.

## Code
- `ops/owner-intelligence/backend/services/ownerAttribution.js` (`compute` is pure; `loadFor` is batched; `assign` is audited)
- `routes/crm.js`:
  - `GET /owners` returns `attribution` and `propertyRefs`; filters `?agent= ?account= ?status=`
  - `GET /owners/:id` returns `attribution`, `assignmentHistory` and `chatEvents`
  - `POST /owners/:id/assign`
- migration `20261031_owner_attribution(.down).sql`
- UI: `components/crm/owner-attribution.tsx`, `app/crm/owners/page.tsx`, `app/crm/owner/[id]/page.tsx`

## Context (production, read-only, 2026-10-31)
- 3,537 owners have been written to by 2 or more accounts.
- Only Argus1 has an agent bound in `agents.whatsapp_session`. Every other account is attributed by persona.

## Limits
- Owner visibility per agent is the existing `/owners` rule (all agents, contact data masked). No new tenant scoping was added.
- "Human vs bot" per outbound message is not stored per message. "Last message by" names the account and its person, not whether a human typed it.
- The agent and status filters run on the top 200 owners of the search; the account filter runs in SQL.
