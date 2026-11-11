# ARGUS ↔ NEXUS Owner Link — integration contract

**Contract version: `2026-11-11.v1`** · Status: **ARGUS side implemented and tested; NEXUS side not implemented.**

This is the interface the NEXUS implementation (Codex) builds against. The ARGUS half exists in `ops/nexus-owner-link/backend` and is exercised by tests that use a stub receiver. Nothing in this document is live in production.

Roles:

- **NEXUS** owns the owner-facing experience: the activation page, the owner account, the Owner Portal, the distribution choices, the canonical property identity and the publication decision.
- **ARGUS** owns the operational data: owner records, inventory, the last genuine availability confirmation, staff verification, and what an agency is allowed to send.
- **2906 Estate** is the origin agency (`agencyKey: "2906"`). Linking an owner to NEXUS does not transfer the 2906 relationship, its clients or its commercial terms.

## 1. Transport and authentication

Both directions are server-to-server JSON over HTTPS (or loopback on the shared host). Browsers never call these endpoints. They are not part of the public `/api/nexus/*` bridge and must never be proxied through it.

| Direction | Base URL | Secret (env on ARGUS) |
|---|---|---|
| NEXUS → ARGUS | `https://<argus-backend>/api/nexus-link/v1` | `NEXUS_LINK_INBOUND_SECRET` (key id `NEXUS_LINK_INBOUND_KEY_ID`, default `nexus`) |
| ARGUS → NEXUS | `NEXUS_OWNER_LINK_URL` (must be `https://`), suggested `https://nexuslink.fit/api/nexus/workspaces/argus-link/v1` so it fits the existing Caddy rule | `NEXUS_LINK_OUTBOUND_SECRET` (key id `NEXUS_LINK_KEY_ID`, default `argus-<agencyKey>`) |

Two different secrets, each at least 32 characters. Until its secret is set, the ARGUS inbound surface answers `503 LINK_NOT_CONFIGURED`, and ARGUS sends nothing outbound.

Every request carries:

```
X-Nexus-Link-Key:       <key id>
X-Nexus-Link-Timestamp: <unix seconds>
X-Nexus-Link-Signature: v1=<hex HMAC-SHA256>
```

Signature base string:

```
<timestamp>.<METHOD>.<path>.<sha256 hex of canonical JSON body>
```

- `path` is the path below the base URL, for example `/events`.
- Canonical JSON: object keys sorted recursively, no whitespace, `undefined` members dropped, arrays in order. Reference implementation: `services/nexusLinkCrypto.js` (`canonicalJson`, `sign`, `verify`).
- The receiver rejects a timestamp more than 300 seconds from its clock and compares signatures in constant time.

Errors use the NEXUS convention: `{"error": "UPPER_SNAKE", "message": "…"}`.

## 2. Identifiers

| Name | Format | Assigned by | Meaning |
|---|---|---|---|
| `agencyKey` | `2906`, `benestates` | ARGUS | Tenant. Every message carries it; a link of one agency does not exist for another. |
| `ownerLinkId` / `linkId` | UUID | ARGUS | Stable reference to one ARGUS owner within one agency. Never an ARGUS row id, never a phone number. |
| `nexusAccountRef` | `[A-Za-z0-9_:-]{4,80}`, e.g. `nxo_<hex>` | NEXUS | The owner account. One account links to at most one owner per agency. |
| `externalId` | `<agencyKey>:<ARGUS ref>`, e.g. `2906:2906-9481` | ARGUS | Agency-specific listing reference. Follows the existing `providerId:externalId` rule. |
| `canonicalPropertyId` | opaque string | NEXUS | One physical property. Several `externalId`s may point to it. ARGUS stores what NEXUS returns and never invents one. |
| `eventId` | `[A-Za-z0-9_-]{8,80}` | sender | Idempotency key of one event. |

## 3. Owner activation flow

1. ARGUS staff create an invitation on the owner profile. ARGUS returns a URL: `<NEXUS_OWNER_PORTAL_URL>#t=<token>` (default portal URL `https://nexuslink.fit/owner/activate`). The token is in the URL **fragment** so it is not sent in the request line or a Referer. ARGUS sends nothing to the owner; staff share the link in a conversation they are already having.
2. The NEXUS activation page reads the fragment and its **server** calls `POST /invitations/resolve`.
3. The owner signs in or registers in NEXUS, reviews the proposed properties and confirms, corrects or rejects each.
4. NEXUS sends `owner.claim_submitted`. ARGUS marks the link `claim_pending`. **Claimed is not verified:** holding the link, or the phone number ARGUS has on file, is not proof of ownership.
5. Ownership is verified explicitly: either ARGUS staff record how they verified it, or NEXUS sends `owner.verified` after its own check.
6. The owner chooses distribution in the Owner Portal. NEXUS sends `distribution.granted` / `distribution.revoked`.
7. ARGUS sends `property.upserted` only for properties that pass the gate in section 6.

Either side can open a dispute (`owner.dispute_opened`, or staff in ARGUS). A disputed link or property stops syncing until it is resolved and verified again.

### `POST /invitations/resolve` (NEXUS → ARGUS)

Request `{"token": "<token>"}`. Response `200`:

```json
{
  "contractVersion": "2026-11-11.v1",
  "agencyKey": "2906",
  "invitation": { "state": "active", "expiresAt": "2026-11-25T10:00:00.000Z" },
  "owner": { "linkId": "<uuid>", "displayName": "Maria Borg", "linkState": "invited" },
  "properties": [
    { "externalId": "2906:2906-9481", "ref": "2906-9481", "town": "Gżira", "propertyType": "apartment",
      "bedrooms": 2, "transactionType": "rent", "claimState": "proposed" }
  ]
}
```

Unknown, revoked and expired tokens all return `404 INVITATION_INVALID`. The response never contains a phone number, e-mail address, street, apartment number, coordinates or notes. Invitations expire after 14 days by default and can be revoked or replaced by staff.

## 4. Events NEXUS → ARGUS: `POST /events`

Envelope:

```json
{
  "eventId": "evt-5f1c…",
  "eventType": "distribution.granted",
  "contractVersion": "2026-11-11.v1",
  "agencyKey": "2906",
  "occurredAt": "2026-11-11T18:00:00.000Z",
  "data": { }
}
```

Response `200`: `{"duplicate": false, "result": { … }}`. Re-sending the same `eventId` with the same content returns `duplicate: true` and changes nothing. The same `eventId` with different content is `409 EVENT_ID_REUSED`. A rejected event leaves no trace and may be corrected and re-sent with the same id.

| `eventType` | `data` | Effect in ARGUS |
|---|---|---|
| `owner.claim_submitted` | `token`, `nexusAccountRef`, `decisions: [{externalId, decision: "confirm"\|"correct"\|"reject", note?}]` | Consumes the invitation, stores the account, link → `claim_pending`, records each decision. |
| `owner.verified` | `linkId`, `nexusAccountRef`, `method`, `evidenceRef?` | Link → `verified`. Only properties the owner confirmed become owner-verified. |
| `owner.dispute_opened` | `linkId`, `reason`, `externalId?` | With `externalId`: that property is disputed and blocked. Without: the whole link is disputed. |
| `distribution.granted` | `linkId`, `externalId`, `channel`, `audienceRef?`, `scopes[]`, `grantedAt?`, `termsVersion?` | Records the owner's authorisation. Replaces an active grant for the same channel and audience. |
| `distribution.revoked` | `linkId`, `externalId`, `channel?`, `audienceRef?` | Revokes one grant, or all grants when `channel` is omitted. If none remain, ARGUS stops sharing and queues `property.withdrawn`. |
| `availability.answered` | `linkId`, `externalId`, `outcome`, `availableFrom?`, `askAgainAt?` | Records the owner's structured answer (section 7). |

`channel`: `origin_agency`, `selected_agency` (requires `audienceRef`), `approved_large_agencies`, `all_eligible_agencies`, `independent_agents`, `nexus_direct_from_owner`, `other_approved`.

`scopes` (at least one; they say exactly what is shared): `listing_data`, `photos`, `availability`, `viewing_schedule`, `approved_answers`.

Error codes: `CONTRACT_VERSION_UNSUPPORTED`, `EVENT_ID_INVALID`, `EVENT_TYPE_UNKNOWN`, `AGENCY_MISMATCH` (403), `LINK_NOT_FOUND`, `PROPERTY_NOT_IN_LINK`, `INVITATION_INVALID`, `INVITATION_CONSUMED`, `ACCOUNT_REF_INVALID`, `ACCOUNT_ALREADY_LINKED`, `ACCOUNT_MISMATCH`, `DECISION_INVALID`, `NOT_CLAIMED`, `LINK_DISPUTED`, `OWNER_LINK_NOT_VERIFIED`, `OWNER_CLAIM_NOT_CONFIRMED`, `CHANNEL_INVALID`, `SCOPES_INVALID`, `AUDIENCE_REQUIRED`, `OUTCOME_INVALID`, `AVAILABLE_FROM_REQUIRED`.

**Consent rule for NEXUS:** no distribution channel and no scope may be pre-selected in the Owner Portal. ARGUS has no way to create a grant on the owner's behalf; the only accepted source is `nexus_owner_portal`.

## 5. Events ARGUS → NEXUS: `POST <NEXUS_OWNER_LINK_URL>/events`

Same envelope, plus `idempotencyKey`. NEXUS must treat `eventId` (or `idempotencyKey`) as idempotent: a retry of a delivered event must not create a second owner, property or listing.

| `eventType` | `data` |
|---|---|
| `owner.profile_upserted` | `ownerLinkId`, `nexusAccountRef`, `originAgency`, `displayName`, `verifiedAt` — and nothing else |
| `property.upserted` | see below |
| `property.withdrawn` | `externalId`, `canonicalPropertyId`, `reason: "owner_authorization_withdrawn"` |
| `distribution.released` | `externalId`, `routeId`, `originAgency`, `originAgentId`, `audienceType`, `audienceRefs[]`, `commercialTermsRef`, `approvedReleaseAt`, `scheduledReleaseAt` — see section 5a |
| `distribution.release_revoked` | `externalId`, `routeId`, `revokedBy: "agency"\|"owner"`, `reason` |

`property.upserted`:

```json
{
  "externalId": "2906:2906-9481",
  "originAgency": "2906",
  "ownerLinkId": "<uuid>",
  "transactionType": "rent",
  "rent": { "amount": 1500, "currency": "EUR", "period": "month" },
  "sale": null,
  "locality": "Gżira",
  "propertyType": "apartment",
  "bedrooms": 2, "bathrooms": 1, "sizeSqm": 85,
  "availability": {
    "status": "available_confirmed",
    "availableFrom": null, "availableUntil": null,
    "availability_last_confirmed_at": "2026-11-10T09:12:00.000Z"
  },
  "distribution": [ { "channel": "nexus_direct_from_owner", "audienceRef": null, "scopes": ["listing_data","availability"], "grantedAt": "…" } ],
  "provenance": { "origin_agency": "2906", "argus_ref": "2906-9481", "first_agency_origin_at": "…", "owner_verified_at": "…" }
}
```

- `transactionType` is `rent` or `sale`. Exactly one of `rent` / `sale` is non-null. ARGUS refuses to send a listing whose type is unclear.
- Price, bedrooms, bathrooms and size are sent only when the owner granted `listing_data`.
- `distribution` repeats what the owner authorised. NEXUS must not publish to a channel that is not listed.
- Photos, street address, coordinates, owner contact details and client data are not part of this version.

Expected response `2xx`:

```json
{ "accepted": true, "canonicalPropertyId": "nxp_…", "publicationState": "unpublished" }
```

`publicationState`: `unpublished`, `published`, `held`, `withdrawn`. ARGUS stores `canonicalPropertyId` and `publicationState` as reported. A `4xx` (except 408/429) is a permanent refusal and is not retried automatically; `5xx` and network errors are retried with backoff, at most 5 attempts, then wait for a manual retry.

When NEXUS matches the listing to an existing canonical property it returns that id. Duplicate candidates go to a review queue on the NEXUS side; they are never auto-merged, and the first uploader gets no exclusive right.

## 5a. Agency distribution routing (cross-agency release)

The origin agency decides when one of its listings is released to other agencies: immediately, after N days (for example 7), on a date, to a chosen audience, or not at all. ARGUS holds the rule and the schedule; NEXUS only learns about a release when it happens.

- `audienceType`: `all_eligible_agencies`, `selected_agencies` (with `audienceRefs`), `approved_large_agencies`, `independent_agents`.
- The delay is counted from `approvedReleaseAt` — the agency's explicit approval — never from an import or sync time.
- A release requires a matching owner grant (section 4) at approval **and** again at release time. An agency rule never substitutes for it. `all_eligible_agencies` from the owner covers `selected_agencies` and `approved_large_agencies`.
- NEXUS must show a listing to other agencies **only** after `distribution.released`, only to the audience named in it, and must remove it on `distribution.release_revoked` or `property.withdrawn`.
- `commercialTermsRef` references an agreement that already exists. Neither side creates an agreement or a fee from a release.
- Off-market listings are not released; `distribution.released` is sent at most once per route.

## 6. The ARGUS sync gate

A property is sent only when all of these hold. Each failure has a code shown to staff.

| Check | Code when it fails |
|---|---|
| Listing has a reference and is a complete, active listing | `PROPERTY_NOT_IDENTIFIED` |
| Not flagged for duplicate review | `DUPLICATE_REVIEW_PENDING` |
| Rent or sale is unambiguous | `PRICE_MISSING`, `RENT_AND_SALE_PRICE_BOTH_SET`, `SALE_PRICE_LOOKS_LIKE_RENT`, `RENT_PRICE_INVALID` |
| Owner link is verified | `OWNER_LINK_NOT_VERIFIED`, `OWNER_LINK_DISPUTED` |
| Owner confirmed this property | `OWNER_CLAIM_NOT_CONFIRMED`, `OWNER_CLAIM_REJECTED`, `OWNER_CLAIM_DISPUTED` |
| At least one active distribution grant | `NO_DISTRIBUTION_AUTHORIZATION` |

Statuses are kept as independent dimensions and are never collapsed into one:

| Dimension | Values | Owner |
|---|---|---|
| Link | `imported`, `linked` | set to `linked` when NEXUS returns a canonical id |
| Owner review | `pending`, `verified`, `rejected`, `disputed` | owner + verification |
| Distribution | `not_authorized`, `approved`, `withdrawn` | owner |
| Publication | `unpublished`, `published`, `held`, `withdrawn` | NEXUS |
| Sync | `never`, `pending`, `synced`, `error`, `blocked` | transport |
| Availability | ARGUS `available_status` (`available`, `available_confirmed`, `upcoming`, `pending_check`, `not_available`, `rented`, `archived`) | ARGUS |
| Freshness | derived from `availability_last_confirmed_at` (section 7) | ARGUS |

## 7. Availability freshness

There is one timestamp: ARGUS `properties.last_confirmed_available_at`. The contract field `availability_last_confirmed_at` is that column under its contract name. NEXUS displays it and must not keep a second, independently updated copy.

Only a genuine availability confirmation moves it:

| `outcome` | Moves the timestamp | ARGUS effect |
|---|---|---|
| `available` | yes | status → `available_confirmed` |
| `available_from` (needs `availableFrom`, `YYYY-MM-DD`) | yes | status → `upcoming`, date stored |
| `temporarily_held` | no | recorded; publication → `held` |
| `reserved` | no | recorded; publication → `held` |
| `rented` | no | recorded; listing → "Rented?" for an agent to confirm; publication → `held` |
| `ask_later` | no | recorded only |

Answers to other questions, permission changes, profile edits and syncs never move it.

Freshness states (defaults; configurable on ARGUS, NEXUS should derive them from the timestamp with the same thresholds):

| State | Age of the last confirmation |
|---|---|
| `recently_confirmed` | under 36 h |
| `reconfirmation_approaching` | 36 h to under 48 h |
| `confirmation_overdue` | 48 h to under 14 days |
| `unknown_stale` | 14 days or more, or never confirmed |

An expired window never makes a listing unavailable by itself.

## 8. Not in this version

These are agreed directions without an implemented contract yet. Do not build against them until a new contract version defines them.

- Photos and media.
- Structured property Q&A (approved answers, outstanding questions).
- Viewing availability (weekly windows, 15/30/60-minute slots, breaks, exceptions, minimum notice, Europe/Malta DST). NEXUS will own the owner calendar; ARGUS will consume it.
- Scheduled reconfirmation prompts sent to owners (the 48-hour cadence). ARGUS outreach and WhatsApp behaviour are unchanged by this version.
- Commission and referral terms.
- The professional "ARGUS Light" view (queue addendum 01). Routing itself is section 5a.
- Agency-to-agency source connections.

## 9. What NEXUS has to build for v1

1. Signed service authentication (section 1) and an `argus-link` receiver with idempotent `/events`.
2. An owner account type and the activation page at the portal URL, calling `/invitations/resolve` from its server.
3. Owner ↔ `(agencyKey, externalId)` links and a canonical property record with external-id mapping and a duplicate review queue.
4. The Owner Portal distribution screen, with nothing pre-selected, emitting `distribution.granted` / `distribution.revoked`.
5. The availability answer control, emitting `availability.answered`.
6. Honouring `property.withdrawn` and reporting `publicationState`.

Until items 1–3 exist and a round trip has been verified against a NEXUS test environment, ARGUS reports NEXUS synchronisation as **pending**.
