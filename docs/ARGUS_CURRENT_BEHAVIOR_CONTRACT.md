# ARGUS owner conversation — behaviour contract (2026-11-09)

Every rule below is enforced in code and has a test. Rules marked *mirror* are on this branch only; production still runs the baseline (see `ARGUS_KNOWN_GOOD_BEHAVIOR_BASELINE.md`).

| # | Contract | Code | Test |
|---|---|---|---|
| 1 | An owner burst is routed **before** any intake question, in this order: privacy stop → human handoff/review → answer the owner's question → correction → availability → private draft → fact update → no reply | `services/ownerTurnRouter.js`, `autoOwnerConversation.routeTurn` | `test/ownerGoldenCases.test.js` (486), `test/ownerTurnRouter.worker.test.js` |
| 2 | A privacy stop ("remove my details", "do not contact/call/WhatsApp me", "wrong number", "got my number illegally", "do not follow up") sends nothing. It marks the owner do-not-contact plus global suppression, cancels pending plans and AI jobs, and creates a privacy review. It wins over a human takeover and a paused thread | `ownerTurnRouter.isPrivacyStop`, `ownerOptOut.markDoNotContact` | worker test "Kevin screenshot", golden 021–029 (K/C/G/H) |
| 3 | The sender identity comes from `whatsapp_accounts.account_persona` and the registry, never from chat text. A third-party auto-reply ("Thank you for contacting Gabriella!") is ignored | `agentIdentityRegistry`, `THIRD_PARTY_AUTOREPLY_RE` | golden 016/017, worker test "Cedric screenshot" |
| 4 | An agency answer only names a firm with `affiliationVerified: true`. Kevin/2906 Estate, Cedric/QuickLets and Gabriela/Sotheby's were confirmed by Kev on 2026-11-09. Unknown or unverified personas → a person answers | `agencyAnswer`, `renderAnswer` | screenshots test "unverified affiliation", worker test "Olga" |
| 5 | Repeated identity question: one short restatement, then a person. Never a third explanation, never the questionnaire | `routeTurn` | worker test "repeated identity question" |
| 6 | Licence, experience, fees, registration, data-access request, photo or website withdrawal, protected-group restriction, brother's number, passport, "not the owner", "?" → human review, nothing sent | `REVIEW_RES` | golden HUMAN_REVIEW (72) |
| 7 | "Real person", "call me", "email instead of WhatsApp", "not a good start / you didn't answer my question" → human handoff and stop for this chat | `HANDOFF_RES` | golden HUMAN_HANDOFF (18), worker test "Gabriela follow-up" |
| 8 | While a person owns the chat, nothing is sent. A clear offer still becomes **one** private staging draft (`published=false`, `is_staging=true`, `pending_check`), deduplicated by owner, town and bedrooms over 30 days | `passiveIntakeDuringTakeover` | worker test "human takeover" |
| 9 | Duplicate webhook, global DNC, paused account, agent drafting, outside the send window → no reply. An offline session → human review | router thread gates | golden 132–138 |
| 10 | Answers in an ongoing thread carry no new greeting. Outreach greetings use the Malta send time: before 12:00 morning, 12:00–17:59 afternoon, 18:00+ evening (*mirror*) | `timeGreeting.js` | `test/timeGreeting.test.js` |
| 11 | Daily outreach target 0–40 per account with an optional ±5 planning envelope. 0 means no activity. The hard cap of 40/day is enforced per send. Saving never arms or sends | `outreachQuota.targetEnvelope`, `POST /outreach/accounts/:id/daily-target` | `tests/outreach-daily-target.test.cjs` |
| 12 | Numeric pace and target fields are never overwritten by a background refresh while the admin is editing | `app/crm/outreach/page.tsx` | same browser test (refresh during typing) |
