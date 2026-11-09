# ARGUS baseline diff and regressions — 2026-11-09

## Screenshot failures (production) → root cause in code

| Incident | Observed | Root cause (production code `0134df18…` / `5a1b64af…`) | Fixed in |
|---|---|---|---|
| ID-01 Cedric | "are u an agent n malta / or u have ur own properties" → "Roughly what's the rent per month?", "How many bedrooms…", "And how many bathrooms?" | `AGENCY_QUESTION_RE` only matched "are you (an) agent". Chat shorthand ("u", "r u", "urs", "own properties") fell through `processStep`'s identity branch into `nextMissingField` → `FALLBACK_QUESTIONS.price/bedrooms/bathrooms` | `72bf5ad` (detector), `7a1fbec` (router first) |
| ID-02 Cedric | Auto-reply "Thank you for contacting Gabriella!" from the recipient | Not a sender problem: the account persona was `cedric`. The auto-reply line was treated as owner text | `7a1fbec` strips third-party auto-replies |
| ID-03 Gabriela | "Please let me [know] who you represent … nothing for sale but might have for rent" → "No worries, thank you for your feedback, please keep me posted…" | "who you represent" (no do/are) did not match. `ownerIntakeStopDecision` / `classifyIntent` read "nothing for sale" as a decline → `FALL1_DECLINE_TEXT` | `72bf5ad`, `7a1fbec` |
| ID-03b Gabriela | "Yes it is worries … not answer my question. That's not a good start." | No handoff rule for a quality complaint | `7a1fbec` → HUMAN_HANDOFF |
| ID-04 Kevin | "…obtained my number illegally. Please remove my details from your database." | Production lacks `ownerOptOut.js` (in A, never deployed). The production detector did not know "remove my details from your database" | A (`ownerOptOut`), `7a1fbec` (router stop before any reply, plus "illegally", "wrong number", "do not call or WhatsApp me", "do not follow up") |
| Persona claims | Cedric/QuickLets and Gabriela/Sotheby's hard-coded with no recorded approval | No verification flag | `72bf5ad` (`affiliationVerified`; Kev confirmed 2026-11-09) |
| GRT-01 | Wrong greeting for the send time | Production has no `timeGreeting.js` (A only) | A; not changed here |
| UI-01 | Pace/target fields revert while typing; no daily target editor; 0 became 30 | `useEffect` overwrote the draft on every server change; `drawTarget` used `\|\| 30`; planner forced `≥1` | `72d957d` |
| UI-02 | "+16" in production vs founder "+15" | Production `outreachPlanner.js` = +16; A = +15 (not deployed) | A; no stored schedules changed |

## Test results — before vs. after (same inputs, isolated test DB)

| Suite | Before (`a610faa` + test infra) | After (`c9a238e`) |
|---|---|---|
| owner-intelligence existing tests | 112/112 | 112/112 |
| Golden cases (486, recovery pack) through the real router | — (no router; the old path has no typed decision) | **486/486** routes; send/no-send, sender name and agency, no interrogation, canonical facts asserted |
| Held-out screenshot and paraphrase checks | — | 9/9 |
| `processStep` worker on the test DB (four screenshot threads, unverified persona, repeat question, takeover draft) | — | 7/7 |
| **owner-intelligence total** | 112/112 | **614/614** |
| outreach-automation | 37/43 | 37/43, the same six failures |
| Outreach UI browser test (mocked API, 360/390/430/1440) | — | 4/4 widths |
| `npx tsc --noEmit` | — | pass |

### The six outreach-automation failures (pre-existing, unchanged, not caused by this branch)

They are identical at `a610faa` (verified by running `git archive a610faa` on the test DB). Codex's outreach recovery changed the behaviour and did not update these tests:
- `planner.test.js` tests 31 / 32 / 33 / 41 / 43 expect the state `auto_prepared` after Auto ON; the code now schedules directly (`scheduled`), so Save All finds `already_scheduled`.
- Test 42 expects +16 / +32 min; the code (correctly per founder) uses +15.

**Decision needed:** should Auto ON schedule immediately, or prepare and wait for Save All? The tests will be updated once that is decided. They were not rewritten blindly.

## Honest limits of the 486/486

The router rules were written while reading these cases, so the pass rate measures coverage, not generalisation. Generalisation evidence is limited to:
- 9 held-out checks (exact screenshot texts plus paraphrases not in the pack);
- 7 worker tests.

Fact assertions cover only keys that the pack uses canonically (bedrooms/beds, location/locality, type, floor, rent/price, global_suppress, private_draft). Every other `expected_facts` key is listed in the decision log, not asserted.
