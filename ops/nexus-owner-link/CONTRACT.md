# ARGUS ↔ NEXUS Owner Link — integration contract

**Contract version: `2026-11-11.v1`, revision 2 (2026-11-12)** · Status: **both sides implemented on branches; verified against each other locally (see [COMPATIBILITY.md](COMPATIBILITY.md)); hosted staging gate open.**

This is the interface both implementations build against. The ARGUS half is in `ops/nexus-owner-link/backend`; the NEXUS half is on `codex/nexus-property-network-20261111`. Nothing in this document is live in production.

**Revision 2 is additive** — the version string on the wire stays `2026-11-11.v1`, and everything a revision 1 implementation sends is still accepted. It records the decisions of 2026-11-12:

1. **NEXUS pushes owner changes to ARGUS** as signed events. There is no pull mechanism in either direction.
2. **`properties.last_confirmed_available_at` in ARGUS is the only availability-confirmation timestamp.** NEXUS may cache it for display and never keeps a competing one.
3. **One permission vocabulary** (section 4a). Anything unrecognised is refused.
4. **An acknowledgement means "validated and persisted"** (sections 4 and 5). ARGUS never reports "synced" on anything less.
5. **No database access between the systems.** NEXUS reads operational data through the signed read API (section 4b).

New in revision 2: events `property.owner_updated`, `viewing.schedule_updated`, `qa.answer_approved`, `qa.answer_withdrawn`; ordering rules; `applied` in every acknowledgement; `nexusPermissions` on grants; the read API; `confirmedExternalIds` in `owner.profile_upserted` and `properties[]` in its acknowledgement.

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

Response `200`: `{"duplicate": false, "applied": true, "result": { … }}`. Re-sending the same `eventId` with the same content returns `duplicate: true` with the stored result and changes nothing. The same `eventId` with different content is `409 EVENT_ID_REUSED`. A rejected event (`4xx`) leaves no trace and may be corrected and re-sent with the same id.

**`applied`** (revision 2): `true` means ARGUS validated the event and persisted its effect in the same transaction. `false` is also a final `200` answer: the event was valid but an event that happened later on the same subject had already been applied (`result.reason` is `STALE_VERSION` or `OUT_OF_ORDER`). NEXUS must not retry it and must not show it as saved over the newer state. If ARGUS is unreachable or answers `5xx`, nothing was recorded; NEXUS reports the failure to the owner and may send the same `eventId` again.

**Ordering.** Events are applied in the order the owner made the changes, not the order they arrive:

- `occurredAt` is required for `distribution.*` and `availability.answered` (if absent, arrival time is used; a time in the future is treated as arrival time).
- A grant is not applied if a later grant or revocation for the same listing and audience (or a later "revoke all") was already applied. A revocation only revokes grants made before it.
- An availability answer is not applied if a later answer for the same listing was already applied.
- `property.owner_updated`, `viewing.schedule_updated` and `qa.*` carry an integer `version` that NEXUS increases per listing (per question for `qa.*`). A version that is not higher than the stored one is not applied.

**No feedback loop.** Applying an inbound event never makes ARGUS emit an event about the same change. An owner's passport edit does not alter the ARGUS listing, so it cannot come back as `property.upserted`. A confirmed availability does change the listing's availability, and the next `property.upserted` carries it — NEXUS applies that as source data and emits nothing in return.

| `eventType` | `data` | Effect in ARGUS |
|---|---|---|
| `owner.claim_submitted` | `token`, `nexusAccountRef`, `decisions: [{externalId, decision: "confirm"\|"correct"\|"reject", note?}]` | Consumes the invitation, stores the account, link → `claim_pending`, records each decision. |
| `owner.verified` | `linkId`, `nexusAccountRef`, `method`, `evidenceRef?` | Link → `verified`. Only properties the owner confirmed become owner-verified. |
| `owner.dispute_opened` | `linkId`, `reason`, `externalId?` | With `externalId`: that property is disputed and blocked. Without: the whole link is disputed. |
| `distribution.granted` | `linkId`, `externalId`, `channel`, `audienceRef?`, `scopes[]`, `grantedAt?`, `termsVersion?` | Records the owner's authorisation. Replaces an active grant for the same channel and audience. |
| `distribution.revoked` | `linkId`, `externalId`, `channel?`, `audienceRef?` | Revokes one grant, or all grants when `channel` is omitted. If none remain, ARGUS stops sharing and queues `property.withdrawn`. |
| `availability.answered` | `linkId`, `externalId`, `outcome`, `availableFrom?`, `askAgainAt?` | Records the owner's structured answer (section 7). |
| `property.owner_updated` | `linkId`, `externalId`, `version`, `fields` | Stores the owner's Property Passport edit for staff review. `fields` is the **complete** set of owner-edited fields at that version, not a delta. Never written to the ARGUS listing. |
| `viewing.schedule_updated` | `linkId`, `externalId`, `version`, `schedule: {weekly[], exceptions[], duration, notice, buffer}` | Stores the owner's viewing preferences (one current row per listing). Creates no appointment. |
| `qa.answer_approved` | `linkId`, `externalId`, `questionKey`, `question`, `answer`, `version` | Stores an answer the owner approved for sharing. |
| `qa.answer_withdrawn` | `linkId`, `externalId`, `questionKey`, `version` | Withdraws it. |

All four revision 2 events require a verified owner link and a confirmed claim on that listing.

`fields` (unknown key or invalid value → `400`, nothing stored): `locality` (≤100), `type` (≤80), `description` (≤4000), `restrictions` (≤1000), `preferences` (≤1000), `bedrooms`, `bathrooms` (integer 0–100 or null), `rent` (integer 1–10 000 000 or null), `sale` (integer 1–1 000 000 000 or null), `intent` (`rent`, `sale`, `both`, empty), `availableFrom` (`YYYY-MM-DD` or null), `amenities` (list from: `ac`, `balcony`, `terrace`, `lift`, `furnished`, `washing_machine`, `dishwasher`, `parking`, `storage`, `heating`, `internet`, `garden`, `pool`, `dryer`, `sea_view`).

`schedule`: `weekly[]` of `{day 0–6, kind: "available"|"blocked", start, end}` and `exceptions[]` of `{date, start, end}` with `HH:MM` times (`24:00` allowed as an end), `duration` 15, 30 or 60, `notice` 0–720 hours, `buffer` 0–240 minutes. No other keys.

`questionKey`: `[a-z0-9][a-z0-9_.-]{1,79}`; `question` ≤300, `answer` 1–2000 characters.

`channel`: `origin_agency`, `selected_agency` (requires `audienceRef`), `approved_large_agencies`, `all_eligible_agencies`, `independent_agents`, `nexus_direct_from_owner`, `other_approved`.

`scopes` (at least one; they say exactly what is shared): `listing_data`, `photos`, `availability`, `viewing_schedule`, `approved_answers`.

Error codes: `CONTRACT_VERSION_UNSUPPORTED`, `EVENT_ID_INVALID`, `EVENT_TYPE_UNKNOWN`, `AGENCY_MISMATCH` (403), `LINK_NOT_FOUND`, `PROPERTY_NOT_IN_LINK`, `INVITATION_INVALID`, `INVITATION_CONSUMED`, `ACCOUNT_REF_INVALID`, `ACCOUNT_ALREADY_LINKED`, `ACCOUNT_MISMATCH`, `DECISION_INVALID`, `NOT_CLAIMED`, `LINK_DISPUTED`, `OWNER_LINK_NOT_VERIFIED`, `OWNER_CLAIM_NOT_CONFIRMED`, `CHANNEL_INVALID`, `SCOPES_INVALID`, `AUDIENCE_REQUIRED`, `OUTCOME_INVALID`, `AVAILABLE_FROM_REQUIRED`.

Revision 2 error codes: `FIELDS_INVALID`, `FIELD_UNKNOWN`, `FIELD_INVALID`, `VERSION_REQUIRED`, `SCHEDULE_INVALID`, `QUESTION_KEY_INVALID`, `ANSWER_INVALID`, `OCCURRED_AT_INVALID`, `PERMISSIONS_INVALID`, `PERMISSION_UNRECOGNIZED`, `PERMISSION_NOT_MAPPED`, `EXTERNAL_IDS_INVALID`, `RANGE_INVALID`, `URL_INVALID`, `SOURCE_NOT_REVIEWED`.

**Consent rule for NEXUS:** no distribution channel and no scope may be pre-selected in the Owner Portal. ARGUS has no way to create a grant on the owner's behalf; the only accepted source is `nexus_owner_portal`.

## 4a. Permission vocabulary and mapping

The contract vocabulary — `channel` + `audienceRef` + `scopes` — is the only one on the wire and in ARGUS. NEXUS Stage A also has five per-agency permission names. Their mapping is fixed here and implemented in `backend/services/nexusPermissionMap.js` (tests: `ownerPush.test.js`):

| NEXUS permission | Contract meaning | In an event |
|---|---|---|
| `view_facts` | channel `origin_agency`, scope `listing_data` | accepted |
| `manage_viewings` | channel `origin_agency`, scope `viewing_schedule` | accepted |
| `market` | none yet | **refused** (`PERMISSION_NOT_MAPPED`) |
| `contact_owner` | none yet | **refused** |
| `receive_leads` | none yet | **refused** |
| anything else | — | **refused** (`PERMISSION_UNRECOGNIZED`) |

Scopes `availability`, `photos` and `approved_answers` have no NEXUS permission name; they are granted in contract form only. In the reverse direction a NEXUS permission is shown as held only when all its scopes are granted on `origin_agency`.

A grant is sent either in contract form (`channel`, `scopes[]`) or, for the mapped names only, as `nexusPermissions: [...]` (the channel is then `origin_agency`). An unknown channel, an unknown scope, an empty scope list or an unmapped permission refuses the **whole** event: nothing is widened, guessed or partially applied. A listing with no valid grant is never sent by ARGUS and never released to another agency (section 6).

## 4b. Read API (NEXUS server → ARGUS)

Replaces any direct database access. Same signing as section 1 (key `nexus`, the path signed is the path below, `POST` so the signature covers the question). Rate limited. Returns no owner name, phone, e-mail, street address, notes or client data.

| Endpoint | Request | Response |
|---|---|---|
| `POST /read/owner-link` | `linkId`, `nexusAccountRef` | `linkState`, `verified`, and for a verified link the confirmed listings: `externalId`, `sourcePropertyId`, `ref`, `claimState`, `facts {locality, type, bedrooms, bathrooms, rent, sale, availableFrom, amenities[], photos[]}`. `404` if the account is not the one that claimed the link. |
| `POST /read/properties` | `linkId`, `externalIds[1–100]` | `linkState` and per listing of that link: `accessValid`, `availability {status, availableFrom, availableUntil, availability_last_confirmed_at, freshness, lastOwnerOutcome}`, `grants[]`. Listings that are not part of the link are absent. After a dispute `accessValid` is `false` and no availability or grants are returned. |
| `POST /read/viewing-busy` | `linkId`, `externalId`, `from` (`YYYY-MM-DD`), `days` (1–31) | Pending and confirmed appointments as timing only: `date`, `time`, `startsAt`, `durationMin`. |
| `POST /read/source-match` | `linkId`, `externalId`, `url` | The reviewed source facts for exactly that link and listing, or `404 SOURCE_NOT_REVIEWED`. ARGUS fetches nothing. |

NEXUS calls `/read/properties` whenever it shows availability or permissions (it may cache the answer briefly for display) and treats `accessValid: false` as "no access".

**Not yet covered by the read API** and therefore still to be specified before NEXUS can drop its database login: the professional workspace's agency-wide reads (on-market state, live release state and next viewing window per released listing), claim status by account before verification, and the staff listing lookup by reference for routing.

## 5. Events ARGUS → NEXUS: `POST <NEXUS_OWNER_LINK_URL>/events`

Same envelope, plus `idempotencyKey`. NEXUS must treat `eventId` (or `idempotencyKey`) as idempotent: a retry of a delivered event must not create a second owner, property or listing.

| `eventType` | `data` |
|---|---|
| `owner.profile_upserted` | `ownerLinkId`, `nexusAccountRef`, `originAgency`, `displayName`, `verifiedAt`, `confirmedExternalIds[]` (revision 2: the listings the owner confirmed) — and nothing else |
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
{ "applied": true, "canonicalPropertyId": "nxp_…", "publicationState": "unpublished" }
```

**Acknowledgement rule (revision 2).** A `2xx` must carry `applied: true`, and that must mean the receiver validated the event and persisted its effect. `accepted: true` (the revision 1 spelling) is read as the same statement. A `2xx` without either is treated by ARGUS as **not delivered**: the event stays queued, the status shows an error, and nothing is reported as synced. A receiver that accepted an event but deliberately did not apply it (for example an older event after a withdrawal) answers `applied: true` only if its stored state is now at least as new as the event.

For `owner.profile_upserted` the acknowledgement lists what was linked: `"properties": [{ "externalId": "2906:…", "canonicalPropertyId": "…" }]` (revision 1 form: `"linkedProperties": <count>`). If fewer listings are linked than `confirmedExternalIds` names, ARGUS treats the event as not delivered. ARGUS stores the canonical ids from this acknowledgement.

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
- Outstanding questions to the owner (approved answers are in revision 2).
- Turning the owner's viewing schedule into ARGUS appointments. ARGUS receives and stores the schedule (revision 2); its appointment lengths are still 10 and 20 minutes against the owner's 15/30/60.
- Staff review actions on an owner's passport edit (accept into the listing, reject). ARGUS stores the edit and shows it; nothing is written to the listing yet.
- Scheduled reconfirmation prompts sent to owners (the 48-hour cadence). ARGUS outreach and WhatsApp behaviour are unchanged by this version.
- Commission and referral terms.
- The professional "ARGUS Light" view (queue addendum 01). Routing itself is section 5a.
- Agency-to-agency source connections.

## 9. State of the NEXUS side and what is left (for Codex)

Items 1–6 of the original list exist at NEXUS `a2068ab` and pass against ARGUS (COMPATIBILITY.md). Left to do on the NEXUS side for revision 2:

1. **Push the remaining owner changes**: `property.owner_updated` when the owner saves the passport, `viewing.schedule_updated` when the schedule is saved, `qa.answer_approved` / `qa.answer_withdrawn`. Send the complete owner-edited field set with a per-listing increasing `version`; treat `applied: false` as "a newer change is already stored".
2. **Remove the ARGUS database login** (`NEXUS_HOUSING_ARGUS_READ_DSN`). Use `/read/owner-link`, `/read/properties`, `/read/viewing-busy`, `/read/source-match`. Name the reads that are still missing (section 4b, last paragraph) so they can be added to this contract first.
3. **Answer `applied: true`** (the current `accepted: true` is still read), and return `properties[]` with canonical ids for `owner.profile_upserted`.
4. **Retire the pull outbox for ARGUS** (`GET /bridge/events`, `/bridge/events/ack`). ARGUS will not poll it.
5. Owner-facing errors: when ARGUS answers `5xx` or is unreachable, nothing was saved — keep the owner's input and let them retry with the same `commandId` (this already works for availability and distribution).
