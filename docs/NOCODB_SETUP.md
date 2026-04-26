# NocoDB CRM Setup

## What is NocoDB?

NocoDB is an open-source Airtable alternative that turns your PostgreSQL database into a smart spreadsheet UI. It connects directly to the existing 2906 database and shows all tables (owners, clients, outreach_log, properties, etc.) with filtering, sorting, and editing.

## Access

**URL:** https://crm.2906.estate  
*(Requires DNS A record: `crm` → `178.104.162.193` — add in Namecheap)*

## First Login

1. Visit https://crm.2906.estate
2. Click **Sign Up** to create the first admin account
3. Use your preferred email and a strong password
4. The first account created automatically becomes the superadmin

## Database Connection

NocoDB is already connected to the 2906 PostgreSQL database. All existing tables are visible under **Teams & Auth → Integrations**.

If the connection ever needs to be re-added manually:
- **Host:** postgres (Docker internal)
- **Port:** 5432
- **Database:** 2906db
- **User:** 2906user
- **Password:** (in VPS .env as POSTGRES_PASSWORD)

## Adding New Users

1. Log in as admin at https://crm.2906.estate
2. Go to **Team & Auth** in the left sidebar
3. Click **Invite** and enter their email
4. Assign role: **Editor** (can edit) or **Viewer** (read-only)

## Key Tables

| Table | Contents |
|---|---|
| `owners` | Property owners with contact details |
| `owner_properties` | Owner's individual properties |
| `clients` | Client leads with budgets/requirements |
| `outreach_log` | All WhatsApp outreach history and cooldowns |
| `warm_contacts` | Pre-qualified leads |
| `website_properties` | Properties published to 2906.estate |
| `admin_users` | Bot admin users |

## Infrastructure

- **Container:** `2906_nocodb` (Docker, port 8080)
- **Proxy:** Caddy at `/etc/caddy/Caddyfile` (auto-SSL via Let's Encrypt)
- **Data volume:** `/opt/2906-system/nocodb`

## Restart Commands

```bash
# Restart NocoDB
docker compose -f /opt/2906-system/docker-compose.yml restart nocodb

# View logs
docker logs 2906_nocodb --tail 50

# Restart Caddy
systemctl restart caddy
```

## DNS Setup (Namecheap)

Add this A record in Namecheap → 2906.estate → Advanced DNS:

| Type | Host | Value | TTL |
|---|---|---|---|
| A Record | crm | 178.104.162.193 | Automatic |

SSL certificate is issued automatically by Caddy via Let's Encrypt once the DNS propagates (usually within 5 minutes).
