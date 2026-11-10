# Weekly Owner Conversation Quality Desk — Implementation Detail

## Screens / dashboard entry

Add or extend an **admin-only** `ARGUS > Intelligence > Owner Conversation Quality` section. Reuse existing CRM layout, auth, tenant boundaries and owner-chat identity source. Do not create an external standalone dashboard if there is an existing Quality/Learning Desk. The desired interface has four views:

1. **Overview**: last 7 days/previous 7 comparison, number of owner conversations, % handled appropriately, direct-question failures, wrong availability, repeated questions, opt-outs, human takeover, messages suppressed, hours blocked and media issues. Each KPI links to a filtered approved contact subset. Show denominator and sample count; do not render fake data.
2. **Needs Review**: high-severity incidents with redacted actual inbound + outbound excerpt; authoritative property facts, what happened, why it is wrong, model/prompt version, exact contact/account via secure link only, proposed correct action, Approve/Correct/Block controls.
3. **Golden Examples**: 20 highest-value GOOD and BAD anonymized cases, stable expected action, evidence, approved correction, fixture ID, regression result. Never list a phone number or raw private address in public downloadable reports.
4. **Releases & Regression**: current deployed prompt/model hash, policy revision, last known-good, latest 136 golden suite and historical 486 suite results by severity, latest canary and rollback status.

## Weekly cadence and notification

- Generate once weekly on **Monday 08:30 Europe/Malta**, over the previous seven calendar days; use IANA timezone (DST-safe).
- An internal in-app administrative digest alerts approved users: `Owner AI: 8 issues need review; 3 P0; 15 good examples preserved` (numbers always from actual computed data).
- Include manual `Generate now` and `Export anonymized report` actions. Report is stored under a versioned immutable report ID, accessible only to authorized tenant admins. Preserve scheduled job configuration and next execution time across restarts.
- If any major P0 occurs (owner opt-out violation, wrong agency represented, false rented while available, repeated spam after explicit no), create immediate quality incident, not wait until Monday; pause only the risky response class or relevant account policy per existing emergency procedure, without interrupting unrelated correct workflows.

## Required report schema (illustration, not production counts)

```
{
  "report_id": "generated UUID",
  "tenant_scope": "authorized tenant only",
  "period": {"from": "2026-11-03", "to": "2026-11-09", "timezone": "Europe/Malta"},
  "runtime": {"backend_commit": "measured", "model_id": "measured", "prompt_hash": "measured", "policy_version": "measured"},
  "denominators": {"eligible_owner_inbound_bursts": 0, "auto_replies": 0, "manual_handoffs": 0},
  "indicators": {
    "direct_questions_ignored": 0,
    "false_unavailable": 0,
    "owner_price_correction_missed": 0,
    "room_studio_misinterpretations": 0,
    "residential_permit_questions": 0,
    "missed_viewing_offers": 0,
    "media_state_errors": 0,
    "unnecessary_questions": 0,
    "quiet_hours_blocked": 0,
    "dnc_events": 0,
    "human_takeover_violations": 0,
    "duplicate_replies": 0
  },
  "cases": [{"case_id":"anonymized ID","reason":"...","severity":"P0|P1|P2","actual_action":"...","expected_action":"...","secure_chat_ref":"server-generated restricted pointer"}],
  "review": {"approved_corrections":0,"pending":0,"new_regression_fixtures":0},
  "release_decision": "HOLD|SHADOW|REVIEW_REQUIRED|ELIGIBLE_AFTER_GATES"
}
```

## Redaction before export

Private telephone numbers, exact addresses, personal names, image bodies, private business contracts, voice recordings and chat session tokens must not be exported to generic LLM prompts. Redacted snippets can include price, approximate dates, 'room/studio' classification and anonymized evidence IDs. Keep full evidence only behind authenticated CRM permissions and retention policy. If report is sent to another product, require explicitly configured safe integration and data minimization.

## Can ChatGPT review reports automatically?

The CRM can create and notify about a scheduled report. ChatGPT will **not** receive the report just because the CRM made it; someone must open/upload it here, or a supported connected application and authorized scheduled workflow must make it available. Do not claim perpetual monitoring, automatic model-weight training or unsupervised deployment. Build the report export and review workflow now; use an authorized integration if one is actually connected and configured.

## Founder's weekly review cycle

- Founder views P0/P1 summary, checks 5–10 redacted conversation comparisons and marks correct action or draft reply.
- Approved corrections produce immutable gold test fixtures and a proposed patch, NOT an immediate live prompt mutation.
- Release CI must replay existing tests plus all new fixtures, report quality deltas, and ask for review before activating new outbound behavior on already-running accounts.
- Production software updates may deploy through verified workflow. Message behaviour can be guarded by existing account Auto/Pause, DNC and high-risk per-class review mode.

## Screenshot-specific observability required

Each quality incident must be explainable in a single admin drawer: **What owner said / What bot believed / What data was stored / What was sent / Why / Which rule failed / What correct action should have been / Which commit and model produced it**. If these fields cannot be filled, add observability to the existing pipeline instead of guessing.
