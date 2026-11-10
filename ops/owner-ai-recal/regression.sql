-- Regression results this release was verified with (2026-11-10). __HASH__ is
-- replaced by deploy.sh with the sha256 of the deployed decision code.
INSERT INTO owner_ai_regression_runs (release, policy_version, code_hash, results) VALUES (
  'owner-ai-recal-20261110', 'owner-decision-2026-11-10.1', '__HASH__',
  $json${
    "golden136": {"label": "136 golden owner cases (spec evaluator)", "passed": 136, "total": 136, "failed": 0},
    "historical486_router": {"label": "Historical 486-case pack — turn router", "passed": 486, "total": 486, "failed": 0},
    "historical486_decision": {"label": "Historical 486 — decision-layer family + safety", "passed": 486, "total": 486, "failed": 0, "note": "6 documented intentional divergences (seeds 034, 091) where the 136 pack is newer"},
    "runtime_worker": {"label": "Real processStep on isolated DB (before/after)", "passed": 17, "total": 17, "failed": 0},
    "quality_report": {"label": "Weekly report, schedule, review, export", "passed": 5, "total": 5, "failed": 0},
    "browser": {"label": "Owner AI Quality page 1440/390/360", "passed": 3, "total": 3, "failed": 0}
  }$json$::jsonb);
