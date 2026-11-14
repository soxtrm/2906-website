# ARGUS × Facebook Business Pages — Meta setup, App Review, QA

Status on 2026-11-14:
- The code is built and tested against a mocked Graph API.
- It is not deployed.
- No Meta app credentials exist in the ARGUS environment.
- **Nothing has been verified against Meta's live API yet.**

## 1. Meta app

Do this at developers.facebook.com, as Kevin or the agency's business portfolio owner.

1. **Create the app.**
   - App type: **Business**, with use case "Manage everything on your Page".
   - That use case adds `pages_show_list`, `business_management` and `public_profile`.
2. **Configure the login product.**
   - **Facebook Login for Business** is enabled automatically on Business apps.
   - Create a configuration of type **User access token**.
   - Include: `pages_show_list`, `pages_read_engagement`, `pages_manage_posts` and `business_management`.
   - Set "Pages" as the asset type.
   - Put the configuration id into `META_LOGIN_CONFIG_ID`.
   - Without a configuration id, ARGUS sends the same permissions as `scope` (classic Facebook Login).
3. **Valid OAuth redirect URI:** `https://crm.2906.estate/integrations/facebook/callback`. It must match `META_OAUTH_REDIRECT_URI` exactly.
4. **Settings → Advanced:** switch on **Require App Secret**. ARGUS sends `appsecret_proof` on every call.
5. **App settings:**
   - Privacy Policy URL.
   - Data deletion callback: `https://crm.2906.estate/api/meta/facebook/data-deletion`.
   - Deauthorize callback: `https://crm.2906.estate/api/meta/facebook/deauthorize`.
   - 1024×1024 app icon.
   - Category.
   - Contact e-mail.
6. **Business Verification** of the portfolio that owns the app. It is required for Advanced Access.

## 2. ARGUS backend environment

The backend reads its environment from the existing env file (`/opt/2906-system`). Never commit these values.

| Name | Value |
|---|---|
| `META_APP_ID` | the app id |
| `META_APP_SECRET` | the app secret (server only) |
| `META_LOGIN_CONFIG_ID` | optional; the Login for Business configuration id |
| `META_GRAPH_VERSION` | default `v27.0` (the latest on 2026-11-14) |
| `META_OAUTH_REDIRECT_URI` | default `https://crm.2906.estate/integrations/facebook/callback` |
| `ARGUS_FB_TOKEN_KEY` | 32 random bytes, base64: `openssl rand -base64 32`. Losing it means every agent must reconnect. |
| `ARGUS_FB_AUTOPUBLISH_SCAN` | `1` turns on the opt-in auto-publish scanner. Leave unset for the first rollout. |

Rollout control:
- Administrators always have access.
- An agent gets access when `agents.feature_entitlements.facebook_pages = true`.

## 3. Permissions

| Permission | Why ARGUS needs it | Review |
|---|---|---|
| `pages_show_list` | Lists the Pages the agent manages so they can pick one. No Page IDs are typed. | Advanced Access |
| `pages_read_engagement` | Reads back the created post (permalink, status) to confirm publication and show it in ARGUS. | Advanced Access |
| `pages_manage_posts` | Creates the agent-approved listing post. Edits or deletes only posts ARGUS created. | Advanced Access |
| `business_management` | Pages owned through a business portfolio appear in `/me/accounts`. Added by the Pages use case. | Advanced Access |

Other access rules:
- Posting also needs the **CREATE_CONTENT** task on the Page. ARGUS checks `tasks` and explains when it is missing.
- **Development mode:** only people with a role on the app can connect. That is enough for Olga's test once she is added as a tester or developer.
- **Live mode** for every agent needs **App Review** for the four permissions above, plus Business Verification.

## 4. App Review checklist

- [ ] Business Verification approved; app set up as a Tech Provider if Meta asks.
- [ ] Privacy policy, data-deletion callback, icon and contact e-mail filled in.
- [ ] At least one successful call per permission in the last 30 days (Olga's test does this).
- [ ] Reviewer test account: a dedicated ARGUS agent login plus a test Facebook Page. Never personal credentials.
- [ ] Screencast: 1080p, no audio, English UI. Sequence:
  1. ARGUS Profile → Facebook Business Pages → **Connect Facebook**.
  2. The Facebook dialog shows the permissions; select the test Page.
  3. ARGUS lists the Page (`pages_show_list`).
  4. Inventory → **Publish to Facebook** → Page → Photos → Review → **Publish now**.
  5. The success screen → **Open Facebook post**. The post appears on the Page (`pages_manage_posts`).
  6. Facebook Publications shows it with its permalink and status (`pages_read_engagement`).
  7. **Edit text**, then **Delete**, both from ARGUS.
  8. A business-owned Page appears in the list (`business_management`).
- [ ] Justifications: use the table in section 3 and write them in your own words for the form.

## 5. Olga test (live, once the app exists)

These steps use a **test Page**. Never publish a real listing to a public Page without its owner's say.

1. Kevin adds Olga as a tester on the Meta app and creates or assigns a test Page that Olga manages.
2. Olga signs in to ARGUS → **Profile** → **Facebook Business Pages** → **Connect Facebook** → approves on Facebook.
3. The test Page appears and is marked Default.
4. **Inventory** → a verified listing of hers → **Facebook** → choose photos → adjust the text → Preview → **Publish now** → "Successfully published" → **Open Facebook post**.
5. Back in ARGUS: the post is in **Facebook Publications** with "Published".
6. **Duplicate:** publish the same listing again. ARGUS asks first.
7. **Revoked access:** on Facebook, Settings → Business integrations → remove the app. In ARGUS, **Check connection** shows "Reconnect required", and publishing is paused.
8. **Disconnect** in ARGUS. Nothing more is published, including queued automatic posts.

## 6. What is not included

- **Facebook Marketplace** listings: not available through the Pages API, so not offered.
- **Posting to personal timelines:** not allowed by Meta for apps. ARGUS only opens Facebook's own **Share Dialog** for the agent to share a link themselves.
- **No browser automation, cookies or scraping** in this integration. Kevin's existing company-page and group tools are separate and untouched.
