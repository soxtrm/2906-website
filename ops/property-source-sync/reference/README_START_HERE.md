# ARGUS Property Source Sync — My Next Home pilot

**Prepared:** 9 November 2026. **Scope:** Long Lets and For Sale. Short Lets remain separate.  
**Deliverable:** Runnable local prototype (SQLite + read-only parser + review dashboard), 8 grounded offline examples, tests and production integration brief for Claude.  
**What is not done:** This package has **not** been installed into the user's live ARGUS repository, has **not** performed a recurring live scan, has **not** imported listings into the canonical ARGUS database and has **not** deployed. The user's Windows machine is currently inaccessible from this chat. The public site could be inspected through the web research tool; the local runtime could not connect to that domain.

## Why this is useful

- Adds a URL-based Source Registry for authorized property providers.
- Detects `NEW`, `UPDATED`, `MISSING_FROM_SOURCE` proposals, idempotently; missing never means rented.
- Offers an approval/rejection queue with source provenance.
- Applies the founder's price rule: **if two clearly comparable, explicitly advertised prices appear in the same current source snapshot, suggest the lower amount and flag that discrepancy for review.** Do not pick deposits, Wi-Fi fees, weekly rates, historical prices or other units.
- Distinguishes Long Let from Sale using the category URL; detail-page tabs are not reliable transaction classification.
- Stores approved records in **local staging only**. Claude must integrate into the existing authenticated ARGUS inventory and shared publication pipeline.

## Quick run (Windows PowerShell or terminal)

```bash
python -m pip install -r prototype/requirements.txt
python prototype/app.py --db ./argus-source-sync-demo.sqlite --port 8765
```

Open http://127.0.0.1:8765/ . Add both URLs in turn:

- `https://www.mynexthome.mt/long-let/` as Long Let
- `https://www.mynexthome.mt/for-sale/` as For Sale

Click **Run example scan** on each. This loads the offline example snapshot of eight publicly listed records. It does **not** query the website or change ARGUS. Review the proposals and Accept/Reject them. The approval writes to an isolated `approved_imports` staging table only. Repeat the example scan: zero new items. One can modify the fixture to test a price update; tests already do this.

## Test locally

```bash
python -m unittest discover -s tests -v
```

### Authorised live polling (not active by default)

`prototype/poller.py` contains a polite read-only HTTP adapter for this one domain, but requires a privileged source record explicitly marked authorized and enabled plus a command-line acknowledgement. It checks robots, restricts domains and redirects, and does not download images. The local demo UI does **not** enable polling because it has no ARGUS authentication/roles. Claude must implement the permissioned enable switch, source agreement record and existing scheduler integration in the real application.

Never treat a public image URL or download ZIP as automatic permission to republish that media. Preserve the original link and source identity until rights are established.

## Files

- `prompts/CLAUDE_IMPLEMENTATION_MASTER.md` — full engineer handoff, execution and release gates.
- `docs/SOURCE_ARCHITECTURE.md` — data flow, data ownership, review, scheduler and security.
- `docs/PRICE_POLICY_AND_EXAMPLES.md` — conservative lower-price selection rule.
- `prototype/source_adapter.py` — HTML/category extraction and price-selection functions.
- `prototype/store.py` — SQLite source observations, diffs, proposals and local approval.
- `prototype/app.py`, `prototype/dashboard.html` — working local UI and API.
- `prototype/poller.py` — gated, read-only provider-domain polling adapter.
- `fixtures/observed_2026-11-09.json` — eight representative public listing cards, **offline snapshot**, no private contacts or copied media.
- `tests/test_source_sync.py` — regression suite.

## Important priority

**Repair/integrate existing sources first.** Do not build another property database, another scheduler or a separate publication route. Deploy verified software changes through the usual approved ARGUS release procedure, but do not activate external scraping or publish third-party media without appropriate rights and review.
