# ARGUS image-pipeline visual regression

Synthetic fixtures only. Nothing in this directory was published or linked to a live property.

| Fixture | Original | `!gptupload` conservative | `!plusupload` premium | Review |
|---|---|---|---|---|
| Living room | [`original/living-room.png`](original/living-room.png) | [`gptupload/living-room.png`](gptupload/living-room.png) | [`plusupload/living-room-v2.png`](plusupload/living-room-v2.png) | PASS: PLUS adds only removable throw, cushion and vase; geometry and fixed features remain recognizable. |
| Bedroom | [`original/bedroom.png`](original/bedroom.png) | [`gptupload/bedroom.png`](gptupload/bedroom.png) | [`plusupload/bedroom.png`](plusupload/bedroom.png) | PASS: PLUS adds removable bedding/cushion/plant; window, bed, wardrobes and room geometry remain. |
| Kitchen | [`original/kitchen.png`](original/kitchen.png) | [`gptupload/kitchen.png`](gptupload/kitchen.png) | [`plusupload/kitchen.png`](plusupload/kitchen.png) | PASS: PLUS adds a plant and oil bottles only; cabinetry, appliances, worktop and window remain. |
| Bathroom | [`original/bathroom.png`](original/bathroom.png) | [`gptupload/bathroom.png`](gptupload/bathroom.png) | [`plusupload/bathroom.png`](plusupload/bathroom.png) | PASS: PLUS adds a small removable plant; shower, sanitary fixtures, tiles and window remain. |
| Unfinished construction | [`original/unfinished.png`](original/unfinished.png) | [`gptupload/unfinished.png`](gptupload/unfinished.png) | [`plusupload/unfinished.png`](plusupload/unfinished.png) | PASS: both improve exposure while preserving bare blockwork, concrete, conduits and unfinished floor; no fictional completion or staging. |

The fixtures were generated and edited with the built-in image-generation tool for visual regression only. Application-level provider calls remain mocked in automated tests because this isolated checkout contains no production Gemini credential. The application continues to use its existing authorized `@google/genai` integration and configured cost/concurrency limits.

## Synthetic processing jobs

- `00000000-0000-0000-0000-000000000010`: source + generated URL persistence, `saved → ready`.
- `00000000-0000-0000-0000-000000000020`: restart checkpoint reuse; provider call count stayed at one.
- `00000000-0000-0000-0000-000000000030` → `00000000-0000-0000-0000-000000000031`: failed parent run and successful manual retry retaining original gallery position 4.

These are deliberately synthetic regression IDs, not production database records.
