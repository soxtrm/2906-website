# Due reminder delivery window — 2026-10-10

Production host: `178.104.162.193`

Rollback snapshot: `/opt/2906-system/backups/reminder-window-20261010`

The deploy updates `services/reminderOutreach.js` so automatic owner reminder
messages are only sent between 08:00 and 20:30 Europe/Malta. Rows that were
blocked solely because the global automation mode was `REVIEW_ONLY` are picked
up again when the mode is `LIVE`, but only when their due date is today or in
the future. Old blocked backlog is not replayed. DNC, permanent owner stops,
human-active states and non-owner contacts remain blocked.

Sender selection excludes active account restrictions and still requires the
WAHA session to be `WORKING` at send time. A lost session is retried within the
same window or moved to the next 08:00 window.

Production verification:

- owner automation mode: `LIVE`
- today due before catch-up: 1 sent, 4 blocked by stale REVIEW_ONLY state
- today catch-up after deploy: 4 sent, 0 failed, 0 waiting, 0 newly blocked
- today final state: 5 contacted / sent
- send window boundary proof: 07:59 false, 08:00 true, 20:30 true, 20:31 false
- backend container restarted and running; source passes `node --check`
- no DNC, opt-out, permanent-stop or old backlog rows were contacted
