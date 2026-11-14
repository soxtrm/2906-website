# ops/facebook-pages — ARGUS × Facebook Business Pages

Agents connect their own Facebook account once. ARGUS then lists the Business Pages they manage, and they publish listing adverts from Inventory. Only official Meta Graph API calls are used. Meta setup, App Review and the live Olga test are in `docs/facebook-pages/META_SETUP.md`.

## Backend
This is an overlay on the live `/opt/2906-system/backend`: new files, plus a 6-line anchor patch to `index.js`.

| File | Role |
|---|---|
| `routes/crmFacebookPages.js` | Staff API at `/api/crm/facebook-pages/*`. Staff JWT, live agent row, and `feature_entitlements.facebook_pages` (admins always allowed). |
| `routes/facebookPagesMeta.js` | Meta's signed data-deletion and deauthorize callbacks at `/api/facebook-pages-meta/*`. |
| `services/facebookPages/settings.js` | Environment config. No hard-coded ids, secrets or versions (default `v27.0`). |
| `services/facebookPages/secrets.js` | AES-256-GCM for tokens (`ARGUS_FB_TOKEN_KEY`), plus redaction. |
| `services/facebookPages/graph.js` | The only module that calls Meta. Bearer header, `appsecret_proof`, error classification. |
| `services/facebookPages/connect.js` | OAuth state, code exchange, long-lived token, `debug_token`, Page discovery, disconnect. |
| `services/facebookPages/property.js` | Which listings may be advertised: owner, no_fb, availability, verification, image rights. Only public-safe fields are read. |
| `services/facebookPages/content.js` | Deterministic ad templates (en/mt/de), custom placeholders, final leak check. |
| `services/facebookPages/publisher.js` | Idempotent create; claim/run/reconcile; retries; edit, delete, check, history. |
| `services/facebookPages/autoPublish.js` | Opt-in scan for newly verified listings. Off by default. |
| `services/facebookPages/jobs.js` | BullMQ queue `facebook-page-publish`, its processor, and a sweeper, all on the existing Redis. |
| `migrations/20261114_facebook_pages.sql` (+ `.down.sql`) | Additive `agent_facebook_*` tables. |

## Commands (on the VPS, from a copy of this folder)

```bash
bash run_isolated_tests.sh
```

```bash
bash deploy.sh --check
```

```bash
bash deploy.sh
```

```bash
bash deploy.sh rollback /opt/2906-system/backups/facebook-pages-<ts>
```

- `run_isolated_tests.sh` restores the backup into a throwaway Postgres and starts a throwaway Redis on an internal network, then runs the unit, integration and BullMQ tests.
- `deploy.sh --check` is a read-only rehearsal: base hash, anchors, syntax.
- `deploy.sh` needs Kevin's go-ahead. It takes a verified backup, applies the migration, copies the files, patches `index.js`, restarts and runs smoke tests.
- `deploy.sh rollback` restores the previous `index.js` and removes the new files.

## Frontend (this repo, deployed by Vercel from `main`)
- `lib/crm/facebook.ts`
- `components/crm/facebook/*`
- `app/crm/integrations/facebook/{page,callback/page,deletion/page}.tsx`
- `app/api/meta/facebook/[action]/route.ts`: an HTTPS relay for Meta's callbacks.

Entry points:
- Profile → Facebook Business Pages card.
- Inventory row and mobile card → **Facebook**.
- Property page → Facebook panel.

Browser tests (mocked backend; Facebook requests are blocked):

```bash
CRM_MOCK_BASE=http://localhost:3077 node --test tests/facebook-publish.test.cjs
```

Evidence screenshots are in `evidence/`.
