# Local validation

- Python sources compiled with `python -m py_compile prototype/*.py`.
- `python -m unittest discover -s tests -v`: 31 tests passed in local synthetic fixtures.
- Fixture: eight source-card observations from public category pages inspected 2026-11-09, not proof of current availability.
- `prototype/app.py` supplies a localhost-only working dashboard with API, persisted SQLite, add-source, demo scan, review decisions. Production access control, automated live fetch, sync into real ARGUS and deployment remain integration tasks for Claude.
- Data contract: no external source media copied or publicly republished. Exact source info and price conflicts retained for admin review.
- Local loopback HTTP/API smoke test: both approved category URLs added; first demo scan produced 4 new Long Lets + 4 new Sales, repeating produced zero duplicates; 8 proposals visible; one proposal approved only into isolated staging.
- Real Chromium screenshot verification could not run because Playwright's browser executable is not installed in this container. UI is provided as runnable HTML, but no browser-visual certification is claimed.
