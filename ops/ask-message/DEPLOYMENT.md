# Owner Ask fact-preservation patch — 2026-10-10

Production backend: `/opt/2906-system/backend` on `178.104.162.193`  
Container: `2906_backend`

## Behaviour

- Keeps client budget/range, nationality, job, group composition and other decision facts in Board/WhatsApp Ask rewrites.
- Rejects a model rewrite that drops protected facts and falls back to the complete agent text.
- Uses a Malta-time `Good morning` / `Good afternoon` / `Good evening` opening only for an owner with no prior durable conversation history.
- Treats history with the owner across listings as one conversation, using `owner_account_labels` plus sent `owner_contact_log` rows.
- Keeps preview, audit body and confirmed relay text identical.

## Production files

- `services/boardAsk.js`
- `services/ownerAsk.js`

Rollback backup: `/opt/2906-system/backups/ask-facts-20261010-130948/`

## Verification

- `node test/boardAsk.fact-preservation.test.js`
- `node test/ask.pipeline.candidate.test.js` (WAHA and relay mocked; no external message)
- Live Gemini composition of the reported `Russian couple / IT / €1600–1700` case passed the fact and Malta greeting assertions.
- Production history query for `#2906-9416` completed successfully.
- Container restarted healthy with database, workers and HTTP listener up.
