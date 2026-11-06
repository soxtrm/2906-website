# ARGUS Inventory Security Guard — 2026-11-06

## Scope

Implemented a narrow, reversible Inventory abuse guard for the explicitly
named Olga, Adrian and Tomas accounts. Existing roles, `active`, board access
and CRM permissions are not changed.

## Rules

- Normal Inventory list loads, filtering and search are not security events.
- Reopening the same listing repeatedly does not count as a bulk-copy pattern.
- A delete attempt is recorded against a distinct listing. The first two
  distinct targets inside 24 hours still follow the agent's existing rights.
- The third distinct delete target is blocked before the archive or hard delete
  and creates a `suspected_inventory_moves` suspension.
- A likely bulk-copy browsing pattern is 60 distinct listing detail opens in
  10 minutes, or 150 distinct listing detail opens in 60 minutes.
- Only accounts enabled in `agent_inventory_security_policies` are monitored.

## Enforcement and recovery

CRM and Schedule Board authentication read the agent's suspension state on
every request, so an already issued JWT stops working immediately. Suspension
is stored separately from role and permissions. An admin-only endpoint clears
only the suspension state:

`POST /api/crm/admin/agents/:id/security-suspension/clear`

Security events and the suspension/clear actions are retained for review. The
event store records only Inventory actions needed for the rule; it does not
monitor general CRM navigation and does not capture message content.

## Verification

`node --test ops/owner-intelligence/backend/test/inventorySecurityGuard.test.js`

9 tests cover Olga, Adrian and Tomas; distinct delete counting; unprotected
agents; repeated single-listing opens; bulk detail browsing; reversible admin
clear; route and migration contracts. Route and service syntax checks pass.

The broader owner-intelligence suite has pre-existing harness failures in the
isolated source mirror (its shared DB proxy test double leaks values between
unrelated suites). The new targeted suite is isolated and passes independently.

## Deployment

Not deployed. The deployment script includes the migration and new service,
but production changes require separate explicit authorization. The migration
has a down file and the existing deploy backup/MD5 guard remains intact.
