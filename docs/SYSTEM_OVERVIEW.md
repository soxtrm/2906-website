# 2906 System Overview

Backend: Node.js on VPS (root@178.104.162.193, SSH key ~/.ssh/id_ed25519)
Container: `2906_backend` (Docker)
Files: `/opt/2906-system/backend/`
Website: https://github.com/soxtrm/2906-website → auto-deploys to Vercel

---

## WhatsApp Accounts

| Session | Phone | Type |
|---------|-------|------|
| `default` | 35699811819 | Kev primary (always first) |
| `Kevsecond` | 35699270699 | Kev second |
| `kevthirdd` | 35699655034 | Kev third |
| `Olga` | 35679010070 | Independent |

**One account active at a time. Never mix accounts in a batch.**

---

## Bot Commands

### Property Posting (from property group or notes chat)

| Command | What it does |
|---------|-------------|
| `!post` | Post property to Facebook |
| `!postpm` | Post to PropertyMarket.com.mt (To Rent) |
| `!postpmsale` | Post to PropertyMarket.com.mt (For Sale) |
| `!postweb` | Post to 2906 website (To Rent) |
| `!postwebsale` | Post to 2906 website (For Sale) |
| `!postall` | Run web → PM → Facebook sequentially (5–10s delays) |
| `!postallday` | Batch-post ALL today's listings from this group (60–180s delays) |

**Example:** Send a property listing in a property group, then reply `!postall` to publish everywhere.

### Client Commands (from notes chat or DM)

| Command | What it does |
|---------|-------------|
| `!clients` | List active clients (last 30 days) |
| `!client [name]` | Full details for one client |
| `!syncclients` | Manually sync Google Sheet → DB (super admin only) |

**Example:** `!client Marc` → shows Marc's budget, locations, move-in date, etc.

### Outreach

| Command | What it does |
|---------|-------------|
| `!outreach` | Start manual outreach flow (bot asks what to write) |
| `!outreach +35699...` | Outreach to specific numbers |
| `!cancel` | Stop current batch immediately |

**Cooldowns:**
- Kevin accounts (default/Kevsecond/kevthirdd): 10-day cross-cooldown + 25-day own
- Olga: 25-day own only
- Admin numbers always bypass cooldowns

### Summarize Commands

| Command | What it does |
|---------|-------------|
| `!summarizereminder` | Scan notes chat for owner availability → send digest |
| `!summarizeclients` | Scan client group (last 4 weeks) → send client digest |
| `!summarizeproperties` | Scan all property groups → deduplicated property list |

### Status & Misc

| Command | What it does |
|---------|-------------|
| `!status` | System health: sessions, DB counts, queue depth |
| `!warm` | Warm contact stats |
| `!refreshwarm` | Re-scan all chats for warm contacts |
| `!sheet [phone]` | Full info for a phone number (owner + outreach + properties) |
| `!positive/negative/ghosted [phone]` | Label conversation in Chatwoot |

### Rented/Sold

Reply `!rented` or `!sold` in a property group to mark a property.

---

## Client Sync from Google Sheet

Sheet: https://docs.google.com/spreadsheets/d/1VhULR6jl8qyMidwPvIidsDuZzXtc01MbdONfnckxq-Y

**Auto-sync:** Every 30 minutes automatically.
**Manual sync:** Send `!syncclients` from notes chat (super admin only).

### Column mapping

| Sheet column | DB field |
|-------------|----------|
| Clients | name + nationalities + group_size + pets |
| Jobs | profession |
| Budget | budget_min + budget_max (e.g. "1500-2500" or "2000") |
| Beds/Baths | bedrooms_wanted + bedrooms (e.g. "3/2") |
| Locations | preferred_locations |
| Features | wishes |
| Viewings from | viewings_available_from |
| Agent | lead_agent |
| Move in | move_in_date (accepts "now", "May 2026", dates) |
| Comments | notes |

### Google credentials setup (one-time)

If sync is not working, the service account credentials file is missing:

1. Go to https://console.cloud.google.com → IAM & Admin → Service Accounts
2. Find the service account used for the existing Sheets sync
3. Keys → Add Key → JSON → download
4. Upload to server: `scp credentials.json root@178.104.162.193:/opt/2906-system/backend/google-credentials.json`
5. Share **both** the clients sheet and the main ops sheet with the service account email (Editor access)
6. Restart: `docker restart 2906_backend`

---

## How to Add a New Admin/Moderator

1. Open the admin dashboard: http://178.104.162.193:3001/admin (or your domain)
2. Log in as admin
3. Go to **Users** tab (admin-only)
4. Click **Add User** → enter email + password + role (admin or moderator)

To make a WhatsApp number an admin (receives bot commands):
1. Edit `/opt/2906-system/.env`
2. Add number to `ADMIN_NUMBERS` (comma-separated, no +)
3. `docker restart 2906_backend`

---

## How to Edit Website Texts

See [docs/EDIT_TEXTS.md](./EDIT_TEXTS.md) for full instructions.

**Short version:** Edit `/messages/en.json` (and other language files) on GitHub → auto-deploys.

---

## How to Add Property Reminders

Send a WhatsApp message in the **notes chat** (self-message to yourself):

```
[Owner Name] available [date/period]
[property details if known]
```

The `!summarizereminder` command will pick these up and compile them.

---

## System Architecture

```
WhatsApp (WAHA) → webhook → Node.js backend
                               ├── adminCommands.js (bot commands)
                               ├── clientIntake.js (new client parsing)
                               ├── outreach.js (outreach batches)
                               ├── pmPost.js (PropertyMarket posting)
                               ├── webPost.js (website posting)
                               ├── fbPost.js (Facebook posting)
                               ├── clientSheetSync.js (Google Sheet sync)
                               └── sheetsSync.js (DB → Google Sheets export)
                 PostgreSQL (clients, owners, properties, outreach_log)
                 Redis (BullMQ job queues)
                 Chatwoot (conversation CRM)
```

---

## Common Issues

**Bot not responding to commands from group:**
Commands work from property groups when sent by the account owner (fromMe). If another admin needs to trigger commands, they should use their own notes chat.

**Outreach skipping everyone:**
Check `!status` — if all numbers are in cooldown, it's expected. Use `!sheet [phone]` to check individual cooldown status.

**Google Sheet sync not working:**
The credentials file may be missing. See "Google credentials setup" above.

**Website not deploying:**
Check Vercel dashboard for build errors. Most common cause: TypeScript type error or missing env var on Vercel.
