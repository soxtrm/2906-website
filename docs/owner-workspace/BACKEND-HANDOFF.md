# SYNC. owner workspace: backend handoff

The frontend is live at https://www.nexussync.one (Next.js, repo `2906-website`,
branch `claude/argus-owner-workspace-20261118`). Today it keeps accounts, chat and
verification in the browser only. Property creation already goes to the live
ARGUS intake. This document is the contract the backend must fulfil so the
frontend can switch from simulation to real.

## Where it lives

Build it inside the existing ARGUS backend (`/opt/2906-system/backend`, Postgres
`2906_postgres`, served on `https://api.2906.estate`). ARGUS already has the owner
database (`owner_contacts`, properties, WhatsApp via WAHA). Do not create a second
owner CRM. If Supabase is used, use it only for auth identities and link every
account to the ARGUS owner by `owner_contact_id`. Owner data stays in ARGUS.

- All routes under `/api/sync/*`; add that prefix to the Caddy API whitelist.
- CORS: only `https://nexussync.one` and `https://www.nexussync.one`, credentials on.
- Session: httpOnly, Secure, SameSite=Lax cookie (`sync_session`), 30 days, rotating.
- Ship as a patch to the live backend with backup, migration and rollback.

## Tables (new)

| Table | Key columns |
|---|---|
| `sync_accounts` | id, email (unique, lower), password_hash (argon2id, nullable for social), display_name, phone_e164 (nullable), phone_confirmed_at, notify_channel (`whatsapp`/`sms`/`email`/`app`), created_at, disabled_at |
| `sync_identities` | id, account_id, provider (`facebook`/`google`/`apple`), provider_uid, email, created_at; unique(provider, provider_uid) |
| `sync_sessions` | id (random 32 bytes, stored hashed), account_id, created_at, expires_at, ip, user_agent |
| `sync_phone_checks` | id, account_id, phone_e164, channel (`whatsapp`/`sms`), token_hash, attempts, expires_at, used_at |
| `sync_owner_links` | account_id, owner_contact_id (FK to ARGUS), role (`owner`/`partner`/`manager`), linked_at, linked_by (`phone_match`/`agent`); unique(account_id, owner_contact_id) |
| `sync_audit` | id, account_id, action, detail jsonb, at |

Chat messages should reuse the existing ARGUS message storage for the owner
contact, so agents see the same thread in the board. If that needs a new table,
add `channel = 'sync'` to the existing one; do not create a parallel inbox.

## Endpoints

Everything returns JSON `{ ok: true, ... }` or `{ ok: false, error: "plain sentence" }`.

### Account
- `POST /api/sync/auth/signup` `{ email, password, name }`. Password must be at least 10 characters and not just digits. Sets the cookie. Returns `{ account }`.
- `POST /api/sync/auth/login` `{ email, password }`. Sets the cookie.
- `POST /api/sync/auth/logout`
- `GET  /api/sync/auth/facebook/start?next=/owner` redirects to Meta OAuth (scope `email,public_profile`).
- `GET  /api/sync/auth/facebook/callback` creates or finds the account by `sync_identities`, sets the cookie and redirects to `https://nexussync.one/owner?welcome=1`. Google and Apple come later with the same shape.
- `GET  /api/sync/me` returns `{ account, phone: { e164, confirmed }, owner: OwnerView | null }`.

### Phone confirmation (required after any sign-up, including Facebook)
- `POST /api/sync/phone/start` `{ phone, channel: "whatsapp" | "sms" }`
  - `whatsapp`: creates a 6-character token (A-Z, 2-9, valid 15 minutes, single use). Returns `{ token, waLink }`, where `waLink = https://wa.me/<ARGUS_MAIN_NUMBER>?text=SYNC%20verify%20<TOKEN>`.
  - `sms`: sends a 6-digit code (valid 10 minutes, max 5 attempts). Returns `{ sentTo: "+356 •••• 12" }`.
- `POST /api/sync/phone/confirm` `{ code }` (SMS path).
- `GET  /api/sync/phone/status` returns `{ confirmed: boolean }`. The frontend polls this every 3 seconds while the owner is in WhatsApp.
- **WhatsApp inbound hook** in the existing ARGUS Main webhook: a message matching `^\s*SYNC\s+verify\s+([A-Z2-9]{6})\s*$` (case-insensitive) is checked against open `sync_phone_checks`. The sender's number becomes `phone_e164` and `phone_confirmed_at` is set. ARGUS replies once: "Your number is confirmed. You can go back to SYNC." The message is not handed to the normal AI or lead flow.
- On confirmation, match `phone_e164` against ARGUS owner phones (normalised E.164). Every match becomes a `sync_owner_links` row with role `owner`, `linked_by = phone_match`. If nothing matches, the owner simply starts empty.

### Owner data (only after the phone is confirmed)
`OwnerView` is a whitelist. Never return internal notes, scores, outreach history,
other owners' contacts or anything an agent wrote about the owner.

```ts
type OwnerView = {
  contactId: number; name: string
  properties: {
    id: number; ref: string; title: string; town: string; type: string
    bedrooms: number; bathrooms: number; sizeSqm?: number
    listingType: 'rent' | 'sale' | 'both'; priceRent?: number; priceSale?: number
    status: 'live' | 'pending' | 'paused' | 'let' | 'sold'
    photos: string[]; availableFrom?: string; description?: string; features: string[]
  }[]
}
```

- `GET   /api/sync/properties` returns OwnerView.properties.
- `POST  /api/sync/properties` takes the same body as `/api/public/property-submit`, linked to the account's owner and marked `source = 'sync'`. It lands in "needs verification" as today.
- `PATCH /api/sync/properties/:id` takes changed fields. Changes are stored as a pending change for an agent to approve, never published directly. Returns `{ status: "pending_review" }`.
- `POST  /api/sync/properties/:id/photos` (multipart `photos`, max 10, max 10 MB each) is pending review too.

### Chat with ARGUS Main
- `GET  /api/sync/messages?after=<iso>` returns messages for the owner's contact: `{ id, at, from: 'owner' | 'argus', sender: { kind: 'system' | 'agent' | 'argus', name?, company?, role? }, text, attachment?: { name, url }, propertyId? }`.
- `POST /api/sync/messages` `{ text, propertyId?, attachment? }` lands in the ARGUS board as an inbound owner message (`channel = 'sync'`), so agents and ARGUS Main answer from the board as they do now.
- Polling every 5 seconds is fine for the first version.

## Rules (non-negotiable)

- Rate limits: signup and login 10 per IP per 15 minutes; phone start 3 per account per hour; 5 SMS attempts.
- Generic login error ("Email or password is wrong"). No account enumeration.
- Possessing a link or invite never grants ownership. Only a confirmed phone match or an agent action creates `sync_owner_links`.
- The owner's phone is never shown to agencies automatically.
- No automatic outreach to owners from this flow, apart from the single verification reply.
- Never store nationality, ethnicity or religion from chat wishes.
- Every link, unlink, login and phone change goes to `sync_audit`.
- Tests: unit tests for token parsing and matching; integration test on a throwaway Postgres; no real owner numbers in tests.

## What the frontend does when this exists

The frontend owner (Claude) switches `lib/owner/store.tsx` to call these
endpoints when `NEXT_PUBLIC_SYNC_API=https://api.2906.estate` is set. Signup,
login, Facebook, the WhatsApp and SMS confirmation, `/me`, properties and chat
replace the browser simulation. The demo (`?demo=1`) stays local.

## Needed from Kev

1. The ARGUS Main WhatsApp number (for `waLink` and the inbound hook).
2. Meta app "ARGUS Social Publishing" (id 1123354370462124): add the product **Facebook Login**. Valid OAuth redirect URI `https://api.2906.estate/api/sync/auth/facebook/callback`; app domains `nexussync.one`, `2906.estate`.
3. An SMS provider for owners without WhatsApp (for example Twilio), or email codes as the first fallback.
4. A decision: ARGUS Postgres only (recommended) or Supabase Auth plus ARGUS.
