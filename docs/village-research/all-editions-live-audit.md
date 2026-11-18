# Published neighbourhood corpus: live delivery audit

Read-only audit on 18 November 2026. The live `www.2906.estate` pointer was independently inspected before and after the crawl and remained `dpl_X1zTXKuTdsJBS4xrwa3md72Y4VaU` (Kerċem source commit `019eefccc6e0d58463a6cf8305dba35db0d0e163`). No deployment or application mutation was performed.

The published neighbourhood sitemap returned HTTP 200 with 81 distinct edition URLs and matched the verified local release bytes. All 81 live documents returned HTTP 200 without following redirects. Every document matched the corresponding local file by SHA-256, had a title, and identified its own exact www URL as canonical. No checked edition had a `noindex` or `none` instruction in its robots meta or X-Robots-Tag header.

The live robots file returned HTTP 200, advertised the neighbourhood sitemap and contained no rule blocking the neighbourhood paths. Only public www documents, sitemap and robots were requested, using three concurrent workers. There were no owner/property mutations, external venue requests or messages.

This checks actual delivery of the full published corpus, beyond the subset sampled during the last release. It does not establish search-engine indexing, rankings or traffic. Those require search-engine evidence and should not be inferred from an HTTP or canonical check.

Structured results, all exact URLs, document hashes, titles and robots values are retained in `all-editions-live-verification.json`. The reproducible crawl script and original output are in `artifacts/20261118-edition-live-audit` in the isolated worktree. No defect was reproduced; no change to functioning pages was needed.
