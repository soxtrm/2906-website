# ARGUS owner intelligence recovery — report 2026-11-09

Branch `claude/argus-owner-intelligence-recovery-20261109`, worktree `D:\2906\nexus-bridge-work\20261109\argus-owner-intelligence-claude`, based on `a610faa` (latest Codex owner/outreach recovery). Production unchanged: no deploy, no migration, no WhatsApp message, no campaign touched. Production was only read (md5, source copy, environment variable names, `whatsapp_accounts` rows).

## Commits

| Commit | Content |
|---|---|
| `dbc3aeb` | Test infrastructure: logger/telegram edge stubs; stale opt-out expectation |
| `72bf5ad` | Verified sender affiliations plus the shorthand agency-question detector |
| `7a1fbec` | `ownerTurnRouter.js`, `processStep` integration, passive intake during takeover, golden/held-out/worker tests, `deploy.sh` NEW list |
| `72d957d` | Daily outreach target 0–40 with ±5, zero = no activity, dirty-safe numeric fields, browser test plus screenshots |
| `c9a238e` | Two answers sharpened after the manual review; decision log of all 486 cases |

Root causes, before/after and test counts: [BASELINE_DIFF_AND_REGRESSIONS.md](BASELINE_DIFF_AND_REGRESSIONS.md). Baseline: [ARGUS_KNOWN_GOOD_BEHAVIOR_BASELINE.md](ARGUS_KNOWN_GOOD_BEHAVIOR_BASELINE.md). Contract: [ARGUS_CURRENT_BEHAVIOR_CONTRACT.md](ARGUS_CURRENT_BEHAVIOR_CONTRACT.md).

## Before → after (exact production wording)

| Thread | Before (production) | After (`processStep` on the test DB) |
|---|---|---|
| Cedric: "are u an agent n malta / or u have ur own properties" | "Roughly what's the rent per month?" | "I'm Cedric, a real estate professional working with QuickLets in Malta. I'm contacting you in that professional capacity, not as the owner of a property." |
| Cedric: "i am agent also … i asked u a questions lol / r u an agent or urs" | "How many bedrooms does it have?", "And how many bathrooms?" | "You're right, I missed your question. I'm Cedric, a real estate professional with QuickLets in Malta. Thanks for clarifying that you're an agent too. Would you prefer to discuss potential collaboration rather than a specific property?" |
| Gabriela: "who you represent … nothing for sale but might have for rent" | "No worries, thank you for your feedback, please keep me posted…" | Identity answer naming Sotheby's; conversation stays open |
| Gabriela: "not answer my question. That's not a good start." | — | Nothing sent; `human_review_required`; escalation to the operator |
| Kevin: "obtained my number illegally … remove my details" | (no stop guaranteed) | Nothing sent; do-not-contact plus global suppression; every other account blocked (asserted with `checkOwnerSend` for Cedric) |

## Manual quality review

I read 33 decisions spread across Kevin, Cedric, Gabriela and the human-takeover variants (identity, privacy, offers, availability, viewing, etiquette, control). Two answers were generic ("private client or broker?", "only one agency?") and are fixed in `c9a238e`. The full log, with `trace_id`, router version and hash, is in `ops/owner-intelligence/evidence/2026-11-09/golden-decision-log.jsonl`. Of the 486 cases, 49 produce a send. Every other case holds, stops or hands off.

## Commands

```
# owner-intelligence (isolated test DB on the VPS, WAHA stubbed); helper: sync mirror to /tmp, then
docker run --rm --network argus-outreach-testnet -v <mirror>/backend:/work -w /work -e NODE_PATH=/app/node_modules \
  -e TZ=UTC --entrypoint node 2906-system-backend --test --test-concurrency=1 --require ./test/helpers/edgeStubs.js test/*.test.js
# router-only, local
cd ops/owner-intelligence/backend && node --test --require ./test/helpers/edgeStubs.js test/ownerGoldenCases.test.js test/ownerTurnRouter.screenshots.test.js
# outreach UI (next dev --webpack on :4291, mocked API)
OUTREACH_URL=http://localhost:4291/crm/outreach node tests/outreach-daily-target.test.cjs
```

## Remaining issues (not fixed in this sprint)

1. **Nothing is live.** Production still runs the baseline. Deploying needs your OK and goes in two steps:
   - `ops/owner-intelligence/deploy.sh` covers the A chain plus this branch; its md5 guard still matches production as of today, and `ownerTurnRouter.js` is in the NEW list;
   - the outreach-automation files (`outreachQuota.js`, `outreachPlanner.js`) and the frontend.
2. **Six outreach-automation tests are red** (pre-existing since `a610faa`). This needs a decision: should Auto ON schedule immediately, or wait for Save All?
3. **Second reply path not routed.** `conversationIntelligence` / `ownerAssistant` (the LLM path) shares the identity detector, the registry and the opt-out detector, but not the router's priority order.
4. **Facts in a mixed burst.** When a burst holds a question and an offer ("might have for rent"), the answer is sent but that turn's facts are not merged. The next turn continues normally.
5. **Not addressed:**
   - the 944-reminder backlog;
   - the "0 duplicates" metric (cross-account identity dedup);
   - eight outreach-enabled Kevin sessions;
   - Auto/Paused status wording beyond Codex's `a610faa`;
   - migrating any stored 16-minute schedules.
6. **Websites for Cedric and Gabriela are not configured.** A website question on those accounts goes to a person.
7. **Untested environments:** real phones (iOS/Android), and a real WAHA session (deliberately not used).

## Rollback

Nothing deployed, so no production rollback is needed. In the repo: `git revert c9a238e 72d957d 7a1fbec 72bf5ad dbc3aeb`. Once deployed, use the `deploy.sh` backup folder printed by the script, plus the down migrations listed there.
