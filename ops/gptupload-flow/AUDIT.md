# `!upload` / `!gptupload` production audit

Audited against `/opt/2906-system/backend` on 2026-10-13 before editing.

- `!upload` has no Facebook Page post. `!upload1` through `!upload9` schedule exactly 1 through 9 Facebook Page posts. All variants otherwise share the same CRM, website, category-group and Facebook-group flow. `noad` overrides the digit and disables both Facebook channel types.
- `handlers/upload.js::parseUploadCommand` is the entry parser. The new parser preserves compact legacy `!uploadN`; GPT commands accept compact or spaced digits.
- `handlers/uploadListing.js::gatherContent` collects the command and same-sender messages from the preceding ten minutes. Upload mode requests the full photo batch; history is bounded at 80 messages. Videos are limited separately.
- `uploadListing.extractListing` performs the one canonical owner/property extraction. Multi-property text is split once, then `uploadImageAssociation` must prove a safe media-to-property assignment or the whole batch stops before property creation.
- `findRecentDuplicate` compares owner phone, locality, bedrooms and price within 60 minutes, then requires equal street/building or description similarity of at least 0.92. `force` retains its existing bypass.
- The canonical property row, sanitized `public_payload`, publishing-state rows, website sync, matching, share links, notifications, category distribution, Facebook Page campaign and Facebook group queue remain owned by the existing upload implementation.
- The photo stage is inserted after canonical text extraction and duplicate resolution and before Cloudinary upload/property insert. Thus every downstream consumer receives the final media package in the first canonical write.
- `!gptuploadv` may convert a canonical duplicate into an existing-property media update. It appends the final media package to that property, updates the same `public_payload`, records provenance and runs the existing downstream dispatch without creating another property.
- Production has `GEMINI_API_KEY` and `@google/genai`, but no `OPENAI_API_KEY`. The configured editor is therefore `gemini-3.1-flash-image`; the vision audit uses `gemini-2.5-flash`. Both are configurable by environment variables.

The processor edits at most ten images, keeps ordering stable, uploads and records every original separately, falls back per image, and uses an edited-image hash to recover the original source before a rerun.

## 2026-10-15 cross-session command repair

Production receives the same WhatsApp group message once per connected WAHA session. The webhook already chose the first session that observed an upload command, but `handlers/upload.js` repeated the selection with the raw provider message id and without the observing session. A command could therefore pass the webhook claim and then be silently rejected inside the upload handler. Other group commands such as `!ask`, `!av`, `!book`, and their confirmation replies still used session-specific deduplication and could run more than once.

All actionable group commands now derive the same session-independent key from the group id, provider timestamp, and normalized command text. The webhook uses that key for both the observing-session claim and Redis deduplication; the upload handler reuses the same key and keeps the session that actually received the message. Ordinary group conversation is excluded from this logical-command key.

The production files were syntax checked, the command, Ask, availability, booking, and session-stickiness suites passed with all external sends mocked, and the backend health check passed after restart. The pre-hotfix rollback is stored at `/opt/2906-system/backend/.rollback/group-command-20261015-prehotfix`.
