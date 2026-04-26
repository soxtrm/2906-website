# Admin Setup

## Pre-created accounts

| Email | Password | Role |
|-------|----------|------|
| kevinsony1@gmail.com | Traindriver1337! | admin |
| olga@2906.com | Traindriver1337! | admin |

**Change Olga's password after first login** via the Users section in the admin panel.

## Login

Navigate to `https://2906-website.vercel.app/admin`

## Role differences

- **admin** — full access: properties, CRM, website content, user management
- **moderator** — can add/edit **their own** listings only; cannot delete others' listings; no access to Users or Content pages

## Adding more users (via admin panel)

Once logged in as admin, go to the **Users** section in the sidebar → "+ Add User". No SSH needed.

## Creating admin via SSH (if needed)

```bash
ssh root@178.104.162.193

# Generate hash
docker exec 2906_backend node -e "
const bcrypt = require('bcryptjs');
bcrypt.hash('YOUR_PASSWORD', 12).then(h => console.log(h));
"

# Insert into DB
docker exec 2906_postgres psql -U 2906user -d 2906db -c "
INSERT INTO admin_users (email, password_hash, role, is_active)
VALUES ('email@example.com', 'HASH_HERE', 'admin', true);
"
```

## !postweb bot command

Use in WhatsApp (admin only):
- Surround property text with dot separators: `.....\n[text]\n.....`
- Reply or type: `!postweb` (To Rent) or `!postwebsale` (For Sale)
- Bot uses Kimi AI to write luxury copy, inserts into website DB, replies with URL

Images from the chat are auto-saved to `/app/uploads/` and watermarked (watermark placeholder until Kevin designs the 2906 logo watermark).
