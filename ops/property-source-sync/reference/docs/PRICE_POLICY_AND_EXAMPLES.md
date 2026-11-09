# Lower evidenced price policy — founder decision

**Do not invent price values.** The founder requests that if a source in its *current snapshot* states two different prices for the **same listing, same transaction type, same currency and same unit/basis**, the importer use the **lower explicitly quoted amount** as the working candidate.

## Decision rules

1. Find amounts in authentic advertised rental/asking-price contexts, not every `€` on the page.
2. Long Let: compare **EUR/month** prices. Sale: compare total **EUR sale asking prices**.
3. If current category card says €1,400/month and current detail says €1,500/month, suggest **€1,400/month**. Save both quotes, source locations and a visible `PRICE_CONFLICT` review flag.
4. The chosen candidate does not change the property's canonical public price until an authorized admin accepts the change.
5. A past snapshot saying €1,400 and a new snapshot saying €1,600 means **proposed price increase to €1,600** — do not keep the cheaper historic value indefinitely.
6. Do not confuse weekly/nightly prices with monthly rent, or sale with rental. If no exact comparable amount is supported, `price=null` and `NEEDS_PRICE_REVIEW`.
7. `€100 utilities deposit`, `€45 Wi-Fi`, agency fee and security deposits are **not** the base asking rent.
8. A source-only provider change may disagree with the owner directly; keep both with timestamps; an agent can override under normal ARGUS source-priority rules.
9. Preserve raw evidence privately. Never imply an owner accepted a price the owner did not verify.

## QA examples

| Current source evidence | Proposal | Reason |
|---|---|---|
| `€1,500 monthly` + `Rent €1,400 monthly` | `€1,400/month` + conflict flag | Two equivalent advertised rent quotes |
| `€1,500 per week` + `€1,400 monthly` | `€1,400/month` | Weekly is different basis |
| `Rent €1,300 monthly`, `Wi-Fi €45 monthly`, `deposit €100` | `€1,300/month` | Extras excluded |
| `€255,000` and `Sale Price: €245,000` | `€245,000` + conflict | Two comparable sale asks |
| `Price on request`, `Utilities €100` | Unknown, review | No advertised rent |
| Yesterday €1,300; today €1,600 (one current ask) | `UPDATED to €1,600` | Snapshot diff, not within-snapshot tie |

## Source-specific detail

The publicly accessible My Next Home detail pages often display **all three category buttons** (`For Sale`, `Long Let`, `Short Let`) even where the actual listing belongs to only one source-category page. Source-category membership and price basis must determine classification. Short Let is explicitly excluded from this connector.
