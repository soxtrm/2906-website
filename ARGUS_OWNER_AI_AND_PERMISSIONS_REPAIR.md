# ARGUS — Owner AI & Permissions Repair (2026-10-22)

Status: **deployed 2026-10-22 02:25Z with Kev's OK.** Backup: `/opt/2906-system/backups/owner-ai-repair-20261022T022552Z`. Production md5 = repo md5 for every changed runtime file. Container tests after restart: ownerAi 21/21, sessionAlert 5/5, agentPermissions 8/8, owner-context-firewall 6/6 (that test was red before the deploy).
Data correction done: property 29496 and conversation 5587 (backups in `/opt/2906-system/backups/owner-ai-data-20261022/`). Owners #5598 and #5630 were **not** messaged, because both had already been answered personally on 21.10.
No owner messages were sent and no production rows were changed. All production access during the investigation was read-only (`BEGIN READ ONLY` SQL, log greps, file reads).

Branch `claude/possibly-rented`; mirror folder `ops/property-distribution-fix/backend`. The commits are:
- `7458fd5`: production snapshot, no changes.
- `f61cd91`: agency identity and price extraction.
- `4d197f5`: provenance, dates, marketing copy, restriction columns.
- `e6891e2`: QR alerts.
- `fc89101`: agent permissions.
- `d1fd5a3`: multi-account review routing.

---

## 1. Reproduced failure cases (production evidence)

| # | Case | Evidence |
|---|---|---|
| 1 | Agency question answered with the questionnaire, then escalated | `owner_auto_conversations` **#5598** (session **Argus5**): "Hello Kevin, what is the name of your agency please?" → bot: "Just to check — do you have a property available to rent out at the moment?" → "What is the name of the agency that you are representing?" → escalation "couldn't determine intent after 2 tries". |
| 1b | Gabriela account | **#5630** (session **Gabriela**): "What estate agency do you work for?" got no answer. The old code would have answered "2906 Estate", which is wrong. |
| 1c | Production regression test already red | `docker exec 2906_backend node test/owner-context-firewall-20260926.test.js` fails: expected "I'm with Quicklets.", actual "I'm Cedric from QuickLets, Rental Agent." |
| 2 | Invented €26,000/month | **#5587** George Cachia (+35699470780, session kevthirdd) → draft property **29496**: `longlet_price = 26000`; checklist note *Rent given as a bare "26" — read as €26,000/month (Malta shorthand); please verify*. No rent was ever stated. |
| 2b | Unsupported marketing copy | Cached copy for #5587: "…offers a great opportunity…", "A great opportunity in Ibrag **at an excellent price**." |
| 3 | Past date advertised | First owner message on **2026-10-21**: "Next vacancy July '26". The checklist stored `available_date: "July"` and `viewable_date: "July 2026"`, which the renderer turned into "Available from July!" and "Viewings from July 2026!". |
| 4 | Restrictions lost | Draft 29496 has `pets_allowed` / `sharing_allowed` / `subletting_*` / `field_provenance` all empty; the restrictions exist only as free-text notes. "We'd have to discuss … So we would discuss" (company lease) was not stored at all. |
| 5 | Olga's drafts blocked | **#2906-9507** and **#2906-9515** (uploaded by Olga) failed with "needs manual categorisation — bedrooms are unknown". The uploader was told "Retry: !recategorize", an **admin-only** command, and Kev fixed 9515/9516 by hand on 21.10. (`!recategorize 9515 1 bed`). |
| 6 | QR alert spam | 3,750 "awaiting QR scan" log lines in 7 days. The throttle is in memory, and `index.js` runs the health pass at every backend start. |
| 7 | Review posted from another account, with an unverified reason | #5587 was collected via kevthirdd and posted via **Kevsecond** with the label "(fallback — kevthirdd was offline)", although kevthirdd was WORKING. Any working member of the review group could post, and Cedric is a member. |

## 2. Root causes

1. **Agency question**:
   - `AGENCY_QUESTION_RE` (in two copies: autoOwnerConversation and conversationPolicy) did not match "name of your agency", "agency that you are representing" or "what estate agency".
   - `agentIdentityRegistry` was keyed by session name and had no entries for Argus1–5. It spelled the Gabriela session "gabriella", so it returned `null` and the conversation escalated.
   - Separately, the unclear-intent branch sent the intake questionnaire even for a direct question.
2. **€26,000**:
   - `processStep` ran the targeted **price** extraction on the owner's first reply because price was the first missing field.
   - `extractPrice`'s bare-digit fallback took "26" from "July '26", and `isBareShorthandPrice` multiplied it by 1000.
   - Nothing stripped date, year, postcode, house-number or reference digits. The same path turns "17, Triq Le Brun" into €17,000.
3. **Marketing**:
   - `canonical2906Renderer.fallbackNarrative` contained the fixed sentence "at an excellent price".
   - The model prompt explicitly allowed "premium, high-end, spectacular, excellent".
   - The model's output was not checked against the facts.
4. **Dates**: `extractDateMention` reduces "July '26" to "July"; neither the merge step nor the renderer checks the chronology.
5. **Restrictions**: `writeDraftProperty` writes pets, sharing and subletting only into `internal_notes`. `extractSublettingMention` only knows "ok/fine/allowed". The upload path maps every "considered" answer to `subletting_allowed = true`.
6. **Permissions**:
   - The category failure reply sends the uploader to an admin-only command, with no valid answers listed.
   - The lifecycle gate uses `ul.resolveAgent`, an exact match on `agents.whatsapp_phones`. Board agents who are registered only via `notify_whatsapp` get **no reply at all**.
   - `!rented` for non-admins exists only in `adminCommands`, which is admin-gated.
7. **QR spam**:
   - The `_lastWaAlertAt` map is in memory, and every restart sends the alert again.
   - QR expiry → FAILED → 5-min backoff restart → new QR, an endless loop.
8. **Routing**: `postChecklistCompleteToAvCentral` picks `pickUploadSession()` or any group member, without a persona check, and writes a hard-coded "was offline" reason.

## 3. Files changed (mirror `ops/property-distribution-fix/backend`)

| File | Change |
|---|---|
| `services/agentIdentityRegistry.js` | Persona-keyed identities: kev = **Kevin Eich, 2906 Estate**; cedric = **Cedric Reiter, QuickLets**; gabriela = **Gabriela, Sotheby's**. The persona comes from `whatsapp_accounts.account_persona` (cached 5 min, with a static fallback). `ARGUS_AGENT_IDENTITIES_JSON` override. One shared `isAgencyQuestion`. Adds `resolvePersonaForSession`. |
| `services/autoOwnerConversation.js` | <ul><li>Agency answer from the persona, with a repeat variant.</li><li>Direct question → human, never the questionnaire.</li><li>Price stripping and the price-only rule.</li><li>Price provenance and verification.</li><li>Chronology gate.</li><li>`missingPriceQuestion`.</li><li>Sanity warnings.</li><li>DISCUSSABLE subletting.</li><li>Restriction columns and `field_provenance` on the draft.</li><li>Persona-safe review routing with the verified fallback reason.</li></ul> |
| `services/conversationPolicy.js` | Uses the shared agency detector. |
| `services/canonical2906Renderer.js` | <ul><li>Price printed only when VERIFIED; otherwise "Price to be confirmed".</li><li>Neutral fallback copy.</li><li>Claim validator (price/value, luxury/pool/sea/penthouse/villa/garden/terrace/furnished, appearance without photos), also applied to cached copy.</li><li>A past or held date becomes "Availability to be confirmed", with no viewing line.</li></ul> |
| `waha.js` | Health alerts come from the persisted episode model; while a scan is pending, QR restarts happen at most hourly. |
| `services/sessionAlertState.js` (new) | Episode state machine (CONNECTED / DISCONNECTED / RECONNECTING / QR_REQUIRED / AUTH_FAILED / RECOVERED) persisted in Redis `wa:session-alert:<session>`. |
| `services/agentPermissions.js` (new) | Permission matrix (§7) and operator resolution (notify_whatsapp OR whatsapp_phones, last 8 digits, plus role). |
| `handlers/upload.js` | <ul><li>Lifecycle commands and `!rented` for agents go through the matrix.</li><li>`!recategorize` for the uploader or assigned agent.</li><li>Replying "3" to the category question resolves the draft.</li><li>Category failure asks one question with the valid choices.</li><li>Override audited with the agent id.</li></ul> |
| `test/ownerAi.repair.test.js`, `test/sessionAlert.episodes.test.js`, `test/agentPermissions.commands.test.js` (new) | Regression tests (§4). |
| `ops/property-distribution-fix/deploy-owner-ai.sh` (new) | Guarded deploy (§10). |

## 4. Tests — before / after

All of these drive the **real** modules (`processStep`, `localExtract`, `mergeExtracted`, `render2906Listing`, `postChecklistCompleteToAvCentral`, `waha.ensureAllSessionsWorking`, `upload.handleWebhookMessage`). Only DB rows, WAHA, Gemini, Redis and the clock are stubbed. "Old" means the unchanged production files from the snapshot.

| Suite | New code | Production code |
|---|---|---|
| `node test/ownerAi.repair.test.js` (T01–T12, T19, T20) | **21/21** | old run with 17 cases: 2/17. The old code sends the questionnaire to T01, nothing to Gabriela, 26000 / 17000 as prices, and posts the review via Cedric in T19c. |
| `node test/sessionAlert.episodes.test.js` (T17, T18) | **5/5** | **0/5**: a duplicate QR alert after a restart, and 6 restarts in 40 min. |
| `node test/agentPermissions.commands.test.js` (T13–T16) | **8/8** | 2/8 |
| Existing mirror tests (`drafts.noAutoPublish`, `upload.rentNotSale`, `categoryCard.oneMessage`, `ownerSendGate.agentAction`, `possiblyRented`, `markRented.groups`, …) | pass | — |

The brief's T-numbers map to these test cases:
- T01, T02, T03, T04 → "T01" … "T04"
- T05 and T06 → one combined case
- T07, T08 (+ T08b legacy draft), T09, T10, T11/T12 → as named
- T13 (+ quoted reference), T14, T15 (+ LUX escalation), T16 (+ outsider) → as named
- T17, T18 → as named
- T19 (+ b/c), T20 → as named

## 5. Corrected identity routing

```
inbound owner question ──► isAgencyQuestion(text)
                            └► resolveIdentityForSession(session)
                                 SELECT account_persona FROM whatsapp_accounts WHERE lower(session_name)=lower($1)
                                 kev      → "Of course. I'm Kevin Eich, a real estate agent representing 2906 Estate in Malta."
                                 cedric   → "Of course. I'm Cedric Reiter, a rental agent representing QuickLets in Malta."
                                 gabriela → "Of course. I'm Gabriela, a real estate agent representing Sotheby's in Malta."
                                 olga/jasmine/unknown → no automatic answer, escalation (nothing invented)
repeated question → "Sure — I'm Kevin Eich from 2906 Estate, based in Malta." (sendGate blocks exact duplicates)
other direct question with no deterministic answer → silent, chat marked unread, operator notified
```
Sessions mapped to the kev persona: `default`, `Kevsecond`, `kevthirdd`, `Argus1`–`Argus5`. Identities can be edited without a deploy via `ARGUS_AGENT_IDENTITIES_JSON`.

## 6. Property data validation rules

- **Price**:
  - It is a price only with a currency or rent anchor (`€`, `EUR`, `/month`, `pm`, "rent/price is", `k`), or when the whole reply is a price.
  - Numbers from dates, years, `'26`, postcodes (`SWQ2081`), phone numbers, references (PD-/2906-) and house/flat/block numbers are removed first.
- **Evidence per price**: `source_message_id`, `source_text`, `parsed_amount`, `currency`, `billing_period`, `evidence` (OWNER_STATED / OWNER_STATED_BARE_NUMBER / OWNER_SHORTHAND_INFERRED), `anomalies`, `verification`.
  - VERIFIED: the price is printed.
  - NEEDS_REVIEW (shorthand, rent < €250 or > €12,000, year-shaped): kept and flagged, **never replaced**, and not printed.
  - MISSING: `price = null`, together with the targeted question, e.g. "The monthly asking rent for the 3-bedroom maisonette in Ibrag is still missing. Could you confirm the price?"
- **Dates**:
  - A month + year that is already past (Europe/Malta, at processing time) is never stored as `available_date` or `viewable_date`. `_date_clarification` records the owner's text, when it was stated and the reason. Nothing is ever moved to the following year.
  - A month without a year stays as stated.
  - The renderer prints "Availability to be confirmed" and no viewing line.
- **Restrictions**:
  - `pets_allowed` and `sharing_allowed` are booleans.
  - A company lease "we would discuss" is stored as `subletting_considered = true`, `subletting_allowed = NULL`, with the note "DISCUSSABLE … NOT approved"; provenance `company_lease = DISCUSSABLE_NOT_APPROVED`.
- **Marketing copy**:
  - It must restate supported facts only.
  - Price, value or "opportunity" claims are never allowed.
  - Luxury/premium/pool/sea/penthouse/villa/garden/terrace/furnished claims need a matching owner fact.
  - Appearance words need photos.
  - Rejected model output falls back to neutral, factual copy.
- **Publication gate**: missing or unverified price, and a date needing clarification, each add a review warning, and a warning holds auto-publication. (Drafts already never auto-publish since `c1109a6`.)

## 7. Permission matrix

| Action | admin (ADMIN_NUMBERS or role=admin) | agent (role=agent, core team) | board (role=board) | anyone else |
|---|---|---|---|---|
| `!available` / `!return` | all properties | all properties | own or assigned (`listed_by_agent_id` / `activity_agent_id`) | ignored, no reply |
| `!rented` | all (existing adminCommands path, unchanged) | all | own or assigned | ignored |
| `!archive` `!priority` `!markrecentlyrented` | all | all | own or assigned | ignored |
| Category 1–4 (`!recategorize REF 3` or a reply "3" to the question) | all | all | own or assigned | ignored |
| Category C / LUX | yes | escalated to Kev | escalated to Kev | ignored |
| `!price` | yes (unchanged) | no | no | ignored |

References are taken from the command, an embedded `#2906-…`, the quoted message id, or the quoted text. Ambiguous references get "send the exact ref". `!rented` keeps `markRented` (audit, match invalidation, unpublish). Nothing is deleted.

## 8. Remaining failures / not verified

- No live owner conversation has exercised the new agency path yet; the evidence comes from container tests and the review warnings computed on the corrected real row.
- Pre-existing, unrelated: the fb-groups job fails with "Failed to launch the browser process" (189 times in the 48 h before the deploy).
- Board-agent scope uses `listed_by_agent_id` / `activity_agent_id`. Properties assigned by other means (contracts, boards) are not counted. Core `agent` role keeps global scope, as before.
- Matching-engine propagation of corrected facts (T20) is verified up to checklist, renderer, warnings and provenance. The CRM `UPDATE` and the matching invalidation for a draft edited later are **not** exercised end-to-end.
- QR episode state is in Redis (volume-backed). A Redis restart without a snapshot could cause one duplicate alert.
- `test/autoPublish.distribution.test.js` already fails on the production file (stale since `c1109a6`). `av-classify` and `seafrontHint` run only inside the container.
- **Side finding:** `[Classifier]` Vertex AI calls fail continuously with 403 `CONSUMER_INVALID` on project `2906-system`. Not investigated here.
- The screenshots `261503–261510.jpg` were not available to me. The cases above were reproduced from production data and logs instead.

## 9. Running production vs local

| File | Production md5 (2026-10-22) | Local |
|---|---|---|
| services/autoOwnerConversation.js | `f2c8cac8a042f85592538cca8c2dc7de` | changed |
| services/agentIdentityRegistry.js | `9baa304764fb3f801946ac0845c67a71` | changed |
| services/conversationPolicy.js | `da55a63956d8e2a900fee42261dd9d77` | changed |
| services/canonical2906Renderer.js | `b3f184870720dc51cd0f713c5ccefcd6` | changed |
| waha.js | `0e892e9c97aa5012307891d00f346c04` | changed |
| handlers/upload.js | `eafeb4cc071673bf4f0c80f4d898b446` | changed |
| services/sessionAlertState.js, services/agentPermissions.js, 3 tests | absent | new |

No database migration: the columns used already exist; QR state lives in Redis.

## 10. Deploy / rollback

```bash
# from the repo, after Kev's go:
scp -r ops/property-distribution-fix/backend/. root@VPS:/tmp/property-distribution-fix/
scp ops/property-distribution-fix/deploy-owner-ai.sh root@VPS:/tmp/property-distribution-fix/
ssh root@VPS 'bash /tmp/property-distribution-fix/deploy-owner-ai.sh'
```
The script:
1. Checks the md5 of every changed file and that the NEW files do not exist yet.
2. Refuses to run if a distribution ran in the last 3 min or an outreach run is active.
3. Makes one backup folder, runs `node --check` on every file and restores everything on any syntax error.
4. Restarts once.
5. Runs the four container tests, including the existing `owner-context-firewall` test.
6. Prints the exact rollback command: restore the backup, delete the new files, restart.
