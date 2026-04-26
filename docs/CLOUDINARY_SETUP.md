# Cloudinary Setup

## Why Cloudinary?

Images uploaded via `!postweb` are stored on the VPS at `http://178.104.162.193:3001/uploads/`.
The website runs on HTTPS (Vercel). Browsers block HTTP images loaded from an HTTPS page (mixed content).
Cloudinary provides HTTPS CDN hosting for free.

## Step 1 — Create a Free Account

1. Go to **https://cloudinary.com/users/register_free**
2. Sign up (free tier: 25 GB storage, 25 GB bandwidth/month)
3. After signup, go to your **Dashboard**
4. Note down: **Cloud name**, **API Key**, **API Secret**

## Step 2 — Add Credentials to VPS

SSH into the VPS and add to `/opt/2906-system/.env`:

```bash
ssh root@178.104.162.193
nano /opt/2906-system/.env
```

Add these lines:
```
CLOUDINARY_CLOUD_NAME=your_cloud_name
CLOUDINARY_API_KEY=your_api_key
CLOUDINARY_API_SECRET=your_api_secret
```

Save and recreate the backend container to pick up the new env vars:
```bash
cd /opt/2906-system
docker compose up -d --force-recreate backend
```

## Step 3 — Install the Cloudinary Package

```bash
docker exec 2906_backend npm install cloudinary --save
```

## Step 4 — Migrate Existing Images

This uploads all existing property images from the VPS to Cloudinary and updates the DB:

```bash
docker exec 2906_backend node scripts/migrate-to-cloudinary.js
```

## Step 5 — Test

Send a `!postweb` command. The bot will upload images to Cloudinary and store HTTPS URLs.
Check the property listing on the website — images should load correctly.

## Troubleshooting

- **"Cloudinary credentials not set in .env"** — the env vars are missing or the container wasn't recreated
- **Images still HTTP** — run the migration script (Step 4)
- **Upload fails** — check API key/secret are correct on Cloudinary dashboard
