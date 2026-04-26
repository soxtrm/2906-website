# How to Edit Website Texts

All public-facing text on the 2906 website is stored in translation files at `/messages/*.json`.
There is one file per language — editing a file and pushing to GitHub triggers an automatic Vercel deploy.

## Languages

| File | Language |
|------|----------|
| `messages/en.json` | English (default) |
| `messages/de.json` | German |
| `messages/ar.json` | Arabic |
| `messages/zh.json` | Chinese |
| `messages/it.json` | Italian |
| `messages/fr.json` | French |
| `messages/es.json` | Spanish |
| `messages/ko.json` | Korean |

## How to edit via GitHub (no code required)

1. Go to **https://github.com/soxtrm/2906-website**
2. Navigate to `messages/en.json` (or the language you want)
3. Click the **pencil icon** (Edit this file) in the top right
4. Make your changes in the JSON editor
5. Scroll down → click **"Commit changes"** → **"Commit directly to main"**
6. Vercel will auto-deploy in ~1–2 minutes

## Key text locations

### Hero section (home page)
```json
"hero": {
  "tagline": "Malta's Premier Real Estate",
  "headline": "Exceptional Properties.",
  "headline2": "Trusted Service.",
  "subheadline": "Discover properties across Malta's most sought-after locations"
}
```

### Why Choose 2906 section
```json
"features": {
  "localExpertise": "Local Expertise",
  "localDesc": "Deep knowledge of Malta's neighborhoods and market trends.",
  "personalService": "Personal Service",
  "personalDesc": "Tailored property search based on your unique requirements.",
  "exclusiveAccess": "Exclusive Access",
  "exclusiveDesc": "Premium listings often unavailable elsewhere."
}
```

### Malta lifestyle benefits
```json
"benefits": {
  "sunshine": "300+ Days of Sunshine",
  "sunshineDesc": "...",
  "gateway": "Gateway to Europe",
  ...
}
```

### Footer tagline
```json
"footer": {
  "tagline": "Malta's premier real estate agency for exceptional properties."
}
```

### Property status labels
```json
"status": {
  "available": "Available",
  "viewings": "Viewing",
  "rented": "Rented"
}
```

## Hardcoded content (requires code edit)

These items are **not** in the JSON files — they require editing the source file directly:

| Content | File to edit |
|---------|-------------|
| About page story paragraphs | `app/[locale]/about/page.tsx` |
| About page stats (500+ properties etc.) | `app/[locale]/about/page.tsx` |
| Contact page address/hours | `app/[locale]/contact/page.tsx` |
| Malta region descriptions | `lib/data.ts` → `regions` array |
| Navigation links | `lib/data.ts` → `navItems` |

To edit hardcoded content: go to the file on GitHub → pencil icon → edit → commit.

## Adding a new language

1. Copy `messages/en.json` to `messages/xx.json` (where `xx` is the language code)
2. Translate all values
3. Add the locale to `i18n/routing.ts` in the `locales` array
4. Add it to the `languages` array in `lib/data.ts`
5. Commit and push
