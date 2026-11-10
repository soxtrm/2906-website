# ARGUS / 2906 — P0 OWNER INTELLIGENCE RE-CALIBRATION, KNOWN-GOOD FREEZE & WEEKLY QUALITY LOOP

Founder directive · 10 November 2026 · Execute in the EXISTING production-linked ARGUS codebase.

## 0. MANDATE: ACTUAL PRODUCT REPAIR, NOT ANOTHER PROMPT WRAPPED AROUND A BROKEN LOOP

The founder reviewed ELEVEN real WhatsApp screenshots from 9–10 Nov 2026 and found repeated failures even after previous “repairs.” This is a severe owner-relationship, data-truth, and regression issue. Treat the supplied exact case annotations and fixtures as acceptance evidence. Preserve working modules; determine root causes from actual inbound events, parsed text/media, owner state, prompt versions, agent/session routing, action planner, scheduler, reply generation and WhatsApp dispatch. Fix the CANONICAL decision path, not cosmetic responses. Complete integration and release with verification, not another stranded worktree.

**Priority invariant: ARGUS's main purpose is to collect accurate property data, but its FIRST conversational obligation is to understand and answer the human's latest message.** It must NEVER blindly harvest fields while ignoring the actual question, refusal, status update or offered appointment. The correct action is often NO MESSAGE.

**The new standard must survive future changes.** Version it, pin it, implement test gates and record real outcomes. Never silently rewrite approved introductions or activate new templates from a specification alone.

### Current and historical source material to inspect FIRST

- The eleven founder WhatsApp screenshots and `02_GOLDEN_REAL_CHAT_FIXES.md` inside this pack (anonymized cases; keep screenshot originals private).
- `qa/ARGUS_GOLDEN_OWNER_CASES_2026-11-10.jsonl` with real-case and synthetic regression scenarios, and `qa/evaluate_decisions.py` for objective checks.
- The previously supplied ARGUS Owner Intelligence Recovery (147 scenarios / 486 variants), Owner Chat Scorecards/Live Inventory and Learning Principles documents: **IMPORT THEIR EXISTING TESTS**, do not replace them with this new pack.
- The verified last-known-good owner reply implementation(s), commit history, active production model/prompt version, baseline deployed code, and recent branches. In particular, inspect the separate Owner Intelligence and Outreach Planner V2 work; **do not blind-merge their large branch trees**.
- Current integrations: WAHA / n8n / backend / Postgres or the actual configured stores, CRM property extraction, source messages, sender attribution, outreach Auto/Pause, quiet hours, suppression, and owner property records. Determine ACTUAL code paths; don't guess schemas from this brief.
- Prior constraints: account-scoped agent identity, owner-wide dedupe, `!=` chat pause semantics if present, consent/complaint/DNC, no bot intervention while a human agent is working, provenance-linked property fields, and no re-asking known facts.

Output a short concrete **baseline trace**: a screenshot case → WhatsApp raw event(s) → merged inbound burst → selected owner/property context → decision/LLM output → validator → sent message → DB mutation, with actual file/line references. Identify whether failure arises from context truncation, role confusion, premature send, missing extraction, delayed/stale message, generic fallback, prompt drift, scheduler, or status propagation. Do not claim root cause before tracing.

## 1. LOCK A PERMANENT KNOWN-GOOD BASELINE

Create or update in the CANONICAL repo:
- `docs/quality/ARGUS_OWNER_CONVERSATION_CONTRACT.md` — immutable product requirements and allowed state transitions.
- `docs/quality/ARGUS_OWNER_KNOWN_GOOD.md` — per feature last verified behavior, test fixture/commit, deployed version, and explicit exceptions.
- `docs/quality/ARGUS_APPROVED_PERSONAS.md` — approved sender identity by WhatsApp account, display name, affiliation, verified website, signature and editorial templates, with hashes and approval metadata.
- `docs/quality/ARGUS_PROMPT_MODEL_REGISTRY.md` — prompt version/hash, model ID, decision-schema version, runtime flags, evaluation set version, and release.
- `qa/owner_conversation/` — machine-runnable golden cases (including this JSONL), regressions, scorecards and a blocked-outbound fixture.
- `ARGUS_RELEASE_MANIFEST.md` — feature, integrated commit, production commit/hash, rollback and known-good version.

Treat current live replies as FAILED evidence, not an approved baseline. Preserve code and data in backup for diagnosis. Establish the last genuinely good implementation by executing old tests, replaying old and new cases, and inspecting human-reviewed results. Keep all working non-reply flows.

**Never define done as 'model prompt improved.'** Done requires passing tests, live system hooked to the correct decision path, transparent deployment, no broken old behavior and monitored post-release quality. A README alone does not freeze behavior; tests and deploy controls must enforce it.

## 2. PROPOSED CANONICAL MESSAGE PIPELINE — BIND TO EXISTING MODULES

`inbound webhooks (idempotent message IDs)`
→ `owner/contact + exact WA session + tenant attribution` 
→ `burst aggregation / media detection / chronological ordering`
→ `load factual memory, unanswered questions, active property and human state`
→ `structured intent and entity extraction (all inbound messages, not only last line)`
→ `evidence-linked state update / conflict resolution` 
→ `reply policy and next-best-action planner` 
→ `hard safety gates / role verification / quiet hours / pause / DNC`
→ `ONE natural concise response OR no-send OR handoff`
→ `render approved persona + deterministic send-time greeting`
→ `single dispatch with idempotency & audited final state`

Use the current architecture's real services; these are required stage boundaries, not a mandate for new databases or a rewrite.

### Burst handling
- Combine consecutive owner messages, captions, image links, photos, voice notes and property cards into ONE context before composing a response. Use a brief, configurable quiet period after the latest inbound event (e.g. 15–35 seconds), with a maximum bound and cancellation when later messages arrive; don't introduce minute-long default latency.
- If a person sends `I'm an agent also` + `and we have a variety` + `of clients`, recognize it as **one agency-role answer**, not three opportunities to ask about bedrooms.
- If a person sends `€2,800` + `yes, available` + `tenant leaves 20 Nov`, update price, marketing/interest availability and occupancy date separately; no apology for nonexistent bad news.
- If a person sends 5 photos, a link, and `viewing tomorrow 3 PM`, treat this as a single property/appointment offer and avoid interrupting with a scripted questionnaire.
- Inbound canned `Thank you for contacting Gabriella` is an auto-responder, not proof the human owner is Gabriella, not an instruction to adopt Gabriella's identity, and not an invitation for an automatic chat loop.
- Prevent duplicate sends on webhook retries and parallel workers. At most ONE automatic response per meaningful inbound burst. If the correct response is no-send, persist the decision and skip dispatch.

### Context that must be present in a decision
Authenticated tenant/brand, exact outgoing WhatsApp account, verified agent persona; contact/owner profile and role (owner, other estate agent, landlord, employee, unknown); recent chronological messages with speaker and timestamps; unresolved owner questions; latest owner statement; links/media extraction status; linked property IDs and per-property canonical facts; existing draft and evidence; outreach/manual pause, DNC/complaint, agent takeover, send window; previous bot questions and owner answers; current stage/intended next action; genuine source permission for image/listing reuse. Use available old history when it materially resolves the current turn, not only the last one or two messages.

### Priority order for interpreting each inbound burst
1. `STOP / DELETE / COMPLAINT / DNC / human takeover` => block automated contact and route as appropriate.
2. `Owner asks direct question / questions bot's identity, affiliation or data use` => ANSWER the question truthfully, or human escalation; do not ask unrelated property questions.
3. `Viewing offer / callback request / appointment / changed terms or important availability` => parse, update, inform assigned agent; never turn into 'not available' or 'rented'.
4. `Owner offers one/multiple property, photo, voice or link` => extract known data, acknowledge briefly only if useful, wait for multi-part messages; ask ONE high-value unresolved question only when genuinely necessary.
5. `Owner declines, property long-term rented, no pets, no subletting` => record exact scope, suppress inappropriate re-asks or pitches.
6. `Simple social/closing signal` => stop; do not restart a checklist.

The planner should return typed intent(s), facts and exactly one `next_action`; it should not instruct the model generically to 'keep the conversation going'.

## 3. OWNER CHAT ACTION CONTRACT

Use or adapt a typed, validated decision interface with fields:

```
{
  "contact_id": "existing canonical ID",
  "conversation_id": "existing ID",
  "tenant_id": "server-resolved",
  "outbound_account_id": "server-resolved",
  "message_ids_in_batch": ["source message ID"],
  "owner_role": "OWNER|AGENT|SERVICE_PROVIDER|UNKNOWN",
  "intent": ["..."],
  "property_refs": ["existing, explicit refs only"],
  "fact_mutations": [{
    "property_ref": "...|null",
    "field": "...",
    "old_value": "...|null",
    "new_value": "...|null",
    "evidence_message_ids": ["..."],
    "confidence": "HIGH|MEDIUM|LOW",
    "precision": "exact|approximate|unknown",
    "mutation_policy": "APPLY|REVIEW|NO_CHANGE"
  }],
  "pending_questions_answered": ["..."],
  "open_questions_from_owner": ["..."],
  "next_action": "NO_SEND|ANSWER_DIRECT|ACKNOWLEDGE_UPDATE|ASK_SINGLE_MISSING|HUMAN_HANDOFF|WAIT_FOR_MEDIA|DEFER|DNC",
  "reason_code": "...",
  "send_eligible": false,
  "needs_human_review": false,
  "draft_reply": "...|null",
  "model_version": "...",
  "policy_version": "..."
}
```

The model proposes; deterministic validators and existing permissions decide. Never let free text write property truth, schedule a viewing, clear DNC, choose a different persona or dispatch independently. Persist the exact causal message IDs, the decision, safe field deltas, delivery outcome and human override. Do not log raw sensitive messages/phone numbers in public artifacts or the weekly export.

### Required reason codes
`OWNER_DIRECT_QUESTION`, `PERSONA_UNKNOWN`, `AGENT_TO_AGENT`, `INBOUND_AUTORESPONDER`, `OWNER_MEDIA_BURST`, `VIEWING_OFFER`, `CALLBACK_REQUEST`, `PRICE_CORRECTION`, `AVAILABLE_CONFIRMED`, `FUTURE_VACANCY`, `LONG_TERM_RENTED`, `NO_PETS`, `NO_SUBLETTING`, `ROOM_NOT_ENTIRE_APARTMENT`, `STUDIO_EXPLICIT`, `QUESTION_ALREADY_ANSWERED`, `RESIDENTIAL_NOT_COMMERCIAL`, `NO_REPLY_REQUIRED`, `HUMAN_ACTIVE`, `MANUAL_PAUSE`, `AUTO_DISABLED`, `OUT_OF_HOURS`, `DNC`, `COMPLAINT`, `UNKNOWN_PROPERTY_BINDING`, `MEDIA_UNREADABLE`, `UNCERTAIN_SENDER`, `CONFLICT_REQUIRES_REVIEW`.

## 4. PROPERTY TRUTH: FACTS MUST NEVER BE MISTAKEN FOR QUESTIONS

**Property subtype / unit level**
- `STUDIO`: single studio unit; do NOT ask how many bedrooms. Represent separate bedrooms only according to the canonical schema (0 or studio designator, not an invented 1).
- `ROOM_IN_SHARED_APARTMENT`: one bedroom for rent in a 3-bedroom shared apartment is ONE available ROOM, not an entire 3-bedroom flat. Capture both `whole_property_total_bedrooms=3` and `available_room_count=1`, plus `other_rooms_occupied=2` if explicit. Existing shared use is known; NEVER ask `Do you accept professional sharing?` as though offering a whole apartment. Do not confuse an owner accepting a room tenancy with authorizing subletting of the whole property.
- `WHOLE_APARTMENT`, `PENTHOUSE`, `VILLA`, `COMMERCIAL_OFFICE`, `RETAIL`, `GARAGE`: distinguish type, tenancy arrangement, transaction mode, and individual units from building identity.
- `3 bedrooms + office` is NOT 4 bedrooms. `3-car garage`, `lift connects floors`, `salt pool` should be captured as their own attributes, not guessed as availability or a viewing booking.
- Media/photos/links attach to EXACT property or pending group; when ambiguous across multiple units, mark unresolved instead of spraying media onto every listing.

**Availability has several separate dimensions**
- `owner_is_willing_to_market` / `offer_exists` vs `physical_occupancy` vs `earliest_possible_moving_date` vs `owner_confirmed_available_from` vs `viewing_offered_at` vs `public_listing_available`.
- `It's available` is positive marketing availability. It is never interpreted as rented, withdrawn or a bad event.
- `It's rented for many years` = unavailable/long-term-tenanted, no routine re-ask; do not pressure with sublet/company offers.
- `Tenant leaves 20 November` = move-out date, NOT automatically confirmed next-day availability or an immediate move-in date. Preserve any older 'mid December available' and flag for clarification only if operationally needed.
- `Available 4 December` exact availability statement. Relative `tomorrow 3 PM viewing` is a proposed viewing slot based on the actual inbound timestamp + Europe/Malta timezone, NOT a confirmed reservation.
- `No pets` means pets prohibited for that property, do not ask for insurance loopholes. `No subletting` means no, do not re-pitch unless owner explicitly changes their position. `No thanks for now` means decline current offer; stop related follow-up, and distinguish from explicit global DNC.

**Price**
- Explicit owner correction `2,800` after old `2,649` => store new quoted asking monthly rent €2,800 with evidence and status, mark older reference stale, refresh drafts/matching only through existing trusted update path; not a conflict that triggers an apology about availability.
- Do not apply cheaper-price source-sync rule to DIRECT explicit owner corrections: newest authoritative owner statement wins unless clarified otherwise. Keep source website vs owner-reported values distinct and auditable. No invented price or term.
- Sale amount is not monthly rent; studio room €900 inclusive is not the rent for the entire flat; multi-unit prices must not leak across units.

**Commercial permit**
- A general residential apartment or villa DOES NOT trigger `What is the permit/license status?`. This is the wrong workflow and wastes the owner's time.
- Ask relevant **commercial use/permit** questions only when the specific unit is verified commercial or a genuine regulated/use-case requirement is relevant. For an ordinary residential apartment, capture the apartment details and continue normally.
- If owner replies `I don't understand what you mean`, explain or withdraw the previous question BEFORE anything else. Do NOT skip ahead to sqm.
- Never ask the owner about YOUR agency's licence when they are asking who YOU represent. Explain the sender identity first.

**Known vs missing fields**
- If a message explicitly says 'Valletta studio', no bedroom question. '3 bedroom sharing apartment', no 'how many bedrooms?' question. 'One room available and other two rented', no 'Is the flat available as a whole?' assumption. 'No pets', never re-ask pets.
- Ask only for a genuinely necessary field missing for the SAME property. Prioritize photos when missing, but do not request already sent photos; verify actual media state before claiming 'cannot open'.
- If a human agent says 'please call me' or an appointment is proposed, prefer handoff; never run a full questionnaire first.

## 5. HUMAN INTERACTION BEFORE DATA COLLECTION

- If the owner says 'Are you an agent in Malta or do you have your own properties?', answer directly. `I'm an agent in Malta, not contacting you as a property owner` where verified; acknowledge they may themselves be an agent; do not ask rent/bedrooms unless a particular property is on the table.
- If the owner says 'Which agency?', state the real verified account. Historical 2906 configuration: Kevin is independent/freelance consultant connected with **2906 Estate** (a collective); Cedric has been connected with **QuickLets**; Gabriela historical configuration has referenced **Sotheby's**, but check TODAY'S ACTUAL account and compliance records. If affiliation cannot be verified for the sending identity, do NOT guess or copy another persona; human handoff. Never claim exactly five years of experience, membership or a licence number unless verified. The real 2906 site may be linked after validation.
- Explain a 2906 freelancer collective in two concise paragraphs, not 'Of course, 2906' or an invented employment relationship.
- Auto-replies are not owner answers; do not use 'Thank you for contacting Gabriella' as a conversational cue to switch persona.
- When a sender asks a call, offer/route a human callback and stop automatic questions. Don't promise the call has occurred; note desired time if any.
- If information arrives after the bot said `I'll pass it on`, parse it anyway and suppress stale follow-ups.
- If the owner clarifies meaning, first acknowledge and repair misunderstanding: `Thanks for clarifying — I meant ...`, and close mistaken question.
- Tone: natural, brief, competent. Acknowledge the useful information, answer the question, optionally ask ONE meaningful thing. Never write 'No worries' to an owner who just said it IS a worry; never 'Sorry to hear' for good news; never `Hope you found the right tenant` after a VIEWING OFFER. Never say `sorry for spam` while continuing to spam.

### Writing quality and greetings
- Validated approved persona-specific introductions for Kevin, Cedric, Gabriela; clean paragraphs with deliberate whitespace. Do not rewrite/fill intro templates casually during real-time inference. Store version/hash and approval.
- Compute greeting using Europe/Malta at ACTUAL SEND time: before 12:00 `Good morning`; 12:00–17:59 `Good afternoon`; >=18:00 `Good evening`, **only if within approved send window**. Historic allowed automated window 08:30–19:00 Malta, unless actual configured policy is more restrictive. No automatic outbound at 00:47, 01:11, 21:36 or 22:19. A new send-time greeting should not be injected into every ongoing reply; avoid greeting over and over.
- Use professional English; 'license' (US) and 'licence' (UK noun) are both valid spelling variants, but language consistency matters. The essential error is that the permit question should NOT have been asked for residential flats.
- One response per inbound burst. No sequential `What about bathrooms?` after an unanswered or irrelevant bedroom question. Grammar check, no mashed together `Great, noted, Is ...` fragments.

## 6. MAKE THE RIGHT DECISION TO SEND NOTHING

**Hard blocks, checked immediately BEFORE dispatch**: owner DNC / personal data deletion request; consent/contact basis and permitted channel; explicit owner refusal to further marketing; human-active or manual conversation takeover; chat pause (`!=` semantics where implemented); account Auto OFF/manual pause; account identity missing; quiet hours; duplicate/parallel worker send; outdated inbound context; unresolved property ambiguity; no meaningful next action; owner reports long-term rented and no immediate follow-up warranted; owner sent simple thanks and conversation closed. Existing outreach/CRM DNC remains global where applicable; no bypass via a second account, persona, follow-up or voice.

- NEVER auto-reactivate dormant/paused campaigns or already disabled accounts during release.
- For `remove my details` stop outreach immediately, create appropriate privacy deletion/restriction request workflow, audit it and ensure suppression across accounts/tenants subject to policy. No further promotional reply. If a legally required acknowledgement is provided it must follow approved privacy policy, not generic solicitation.
- Inbound suspicious phishing / unknown links / media: safe parsing only; don't fetch unknown external sites through unguarded browser requests or dump owner private content into third-party models unnecessarily.
- During test/replay use synthetic/redacted content and *mock dispatch*, never contact screenshot owners for testing.

## 7. WEEKLY QUALITY MONITOR — FOUNDER REQUEST

Implement a recurring administrative intelligence report inside existing ARGUS CRM, ideally Monday 08:30 Europe/Malta covering the preceding 7 days. Keep report generation independent from outbound WhatsApp. It must be actually scheduled and persistent through worker restart, with a manual 'Generate report' button and download as `JSON + human-readable MD/HTML`. Admin-only, per-tenant/private, with redacted excerpts and direct **authenticated** links to the underlying chats, never raw public numbers.

The report must show at minimum:
- Overall automated owner conversations and messages by verified persona and account; no inflated sample sizes.
- Messages sent, drafted, suppressed, handoff, stop, opted-out, complaints and late/out-of-hours attempts blocked.
- Owner question answered on first attempt, wrong-topic reply rate, unneeded/repeat question rate, incorrect property-type interpretation rate, false unavailable/rented rate, price correction handling, missed viewing/callback offers, media processing failures, wrong permit-question attempts, confusing language/grammar, duplicate sends.
- Top 10–20 anonymized BAD conversations, each with source facts, actual reply, expected next action, root-cause hypothesis, source account, model/prompt version, downstream consequence and secure review link.
- Top 10 GOOD conversations and reason the reply was appropriate, to freeze as positive regressions.
- Per-persona and per-intent breakdowns; compare to prior week, with sample size/confidence and baseline.
- Active prompt/model hashes, new releases, setting drift, toggles/quiet-hour violations and exact code version; never conclude 'AI learned' without evidence.
- A ranked fix queue with severity P0/P1/P2, regression fixtures to add, proposed safe corrections, owner/assignee, approval status and whether the affected route should be placed in DRAFT_ONLY.
- A weekly 'Founder's Review' button: Approve example / Correct answer / Mark wrong context / Block future reply / Request human route. Corrections become immutable labelled data, not blind reinforcement.

**Important technical boundary**: The CRM can autonomously GENERATE and STORE the digest. ChatGPT cannot automatically receive/read internal CRM reports merely because a report exists. To route it to ChatGPT, set up an authorized connector/scheduled delivery through a supported connected app or provide a downloadable digest here. Do not invent a direct ChatGPT ingestion API or claim the assistant continuously monitors ARGUS. Founder must explicitly authorize any external sharing of private conversation content; prefer anonymized payloads. A new model/prompt may be proposed from weekly reports, but NEVER self-deployed into live owner chats without offline evaluation, quality gates, versioning and an approval workflow.

## 8. CONTINUOUS IMPROVEMENT, WITH NO MODEL DRIFT

Scheduled quality loop:
1. Capture production decisions with consented/redacted observability.
2. Sample by risk/intent/persona; route critical errors to admin immediately; aggregate weekly.
3. Human correction saved as `old_action`, `desired_action`, `what fact/intent was missed`, `evidence`, `policy_version`.
4. Convert each correction into a new GOLDEN fixture and a reason-code guardrail when deterministic.
5. Replay ENTIRE historical regression suite + new tests against CANDIDATE prompt/model/branch and known-good reference.
6. Compare quality per decision type, including 'send nothing'; no overall score can hide safety regressions.
7. Review representative real but redacted outputs. Generate a candidate release only if new candidate improves or matches all hard gates.
8. Roll out behind a controlled versioned switch, initially review/shadow for risky intents, with rollback on first serious regression.
9. Monitor 24/48h after release. Update immutable release manifest and weekly report.

Do not 'train continuously' by turning every WhatsApp reply into ground truth. User corrections are useful labelled examples; LLM runtime does not autonomously update model weights. Prevent prompt auto-editing by accidental template regeneration, config drift or deploy resets. Keep the approved messages and model prompt under immutable review-controlled versioning.

## 9. EXACT RELEASE GATES / TESTS

At least the following MUST pass against the actual deployed pathways, not only an isolated LLM prompt:

**Hard gates (zero tolerance)**
- DNC, deletion, no thanks for current offer, blocked contacts, manual takeover, pause, Auto OFF and quiet hours honoured; no cross-tenant or cross-persona send.
- No residential permit/license questions. No room-sharing/sublet pitch to long-term rented or already room-shared contexts.
- No 'not available' interpretation of affirmative 'available'. No treatment of tentative VIEWING OFFER as viewing CONFIRMED.
- No unanswered direct question followed by an unrelated questionnaire.
- No duplicate outgoing messages for one inbound burst/retry; no two autonomous responses within the same unsettled owner burst.
- No approved message template silently replaced by generated new copy; no unapproved template activated for live Auto ON accounts.
- No old verified property attribute silently overwritten by uncertain model inference; exact owner corrections may replace stale values with trace.

**Quality gates** (adopt measured thresholds in CI and do not fake counts)
- 100% of screenshot-derived `S` cases and prior historic high-severity regression cases pass.
- 100% critical safety and suppression test cases pass.
- Direct owner question is addressed before any property questionnaire in all golden tests.
- At least 98% correct primary intent in curated test set and at least 95% correct critical property field extraction on supported cases; review failures individually. These are release targets, not claims of current performance.
- For normal automatic introductions and replies, approved English grammar, paragraph style and exact persona verified by configured sender account.
- Verify 11 Nov 2026 at 08:30/11:59/12:00/17:59/18:00/19:00, weekend/DST, 00:47, 01:11, 21:36, 22:19. Evaluate server timezone vs Malta send time.
- Media batch, forwarded cards, typed + photo + voice, Webhook out-of-order and repeated messages, duplicate workers, delayed/superseded actions, account switching, human agent intervening between draft/dispatch.
- Live shadow dashboard reports accurate proposed vs actual action without sending test messages.
- Stable owners/states and raw property data preserved across deploy, rollback, and restarts.

**End-to-end review**: Run the existing 486-case pack, new JSONL and additional production snapshots in a private fixture harness; count passed/failed, don't claim old 486 pass unless rerun. Actual sender journey: WAHA event → CRON/worker → owner fact updates → action plan → approved persona render → dispatch gate (mock) → dashboard. Simulate actual in/out order. Verify no stale batch persists once owner corrects a fact.

## 10. BOUNDED IMPLEMENTATION PHASES (DO THE WORK)

Phase A: Pin production and existing known-good behavior; preserve all active dirty branches and backup; trace screenshot failures and establish a root-cause matrix. This is BOUNDED diagnosis with concrete files, not another general audit.
Phase B: Fix the decision path, identity/tenant binding, burst handling, state extraction and next-best-action routing. Add required deterministic gates.
Phase C: Import all golden tests, including original 486 historical cases, run as executable regression suite; add real screenshot cases and no-send tests.
Phase D: Add approved persona rendering, send-time greeting, verified affiliation and professional copy; keep drafts separate from approved live templates.
Phase E: Implement the weekly CRM Quality Report and review queue, persistent scheduler, privacy redaction, export, review actions and version diff.
Phase F: Integrate on current live backend/frontend, deploy once high-risk release gates pass, preserve rollback, verify correct runtime prompt/model versions, test authenticated dashboard. DO NOT re-enable paused campaigns, start outreach or send real owner messages as part of QA. Keep uncertain reply classes in safe DRAFT_ONLY/review mode until validated, while retaining already-authorized campaign settings.
Phase G: Observe and instrument post-release quality; keep real redacted failures, retroactively add golden fixtures and enforce CI before every future release.

Normal *software deployment* is authorized when safe and verified; don't repeat the blanket "no deploy" error. Real outbound campaign activation and access to private customer records retain their own permission boundaries.

## 11. OUTPUT/PROOF REQUIRED FROM CLAUDE

Return:
1. Exact root causes per founder screenshot, linked to real code and prompt/model versions.
2. Actual before/after conversation examples, not only code diff.
3. Structured DB mutations for studio/room/price/availability/viewing and explicit refusals.
4. Test coverage, true pass/fail results, prior 486-case regression status and new case count.
5. Screenshot of weekly Quality Report and Founder Review in existing ARGUS CRM (redacted).
6. Known-good policy/prompt hashes and immutable approved persona template registry.
7. Real deployed service/frontend commit, production version, changed files and rollback target.
8. Proof of account Auto/Pause unchanged and no live owners messaged during QA.
9. Specific remaining blockers, with draft/review mode for unsafe or ambiguous cases; a release is not accepted just because a model writes plausible text.

## 12. FOUNDER'S DEFINITION OF DONE

- Agent questions are answered; owner notes are understood; data is correctly saved; the bot knows when to stop.
- It never asks about bedrooms for a studio, full-property sharing for a one-room rental, permits for normal residential apartments, or subletting for a long-term-rented property after an explicit no.
- Price, availability and viewing offers are recorded without reversing their meaning.
- Approved professional Kevin/Cedric/Gabriela sender voice remains stable and correct.
- All previously good ARGUS functionality remains protected by regression tests and release manifests.
- Each week the admin sees a compact, accurate quality report and can correct examples for an evaluated next release.
- The fixed behavior is actually wired into and verified on production, not left in a parallel worktree.
