#!/usr/bin/env python3
"""Facebook one-click publishing for every agent (2026-11-18).

Exact-match edits on the live backend. Every anchor must occur exactly once; nothing is written otherwise.

  apply_overlay.py <backend_dir> [--check]

What changes:
  * routes/crmFacebookPages.js: Board accounts with board access may use the Facebook Pages API for their
    own connection and their own Pages; the per-agent switch feature_entitlements.facebook_pages stays as an
    off switch (false = no access) instead of an opt-in.
  * services/facebookPages/property.js: any agent may publish any listing that is publishable. The rule
    "only the listing agent" is replaced by "not another agent's exclusive listing". All other blockers
    (owner said no Facebook, draft, archived, offline, unavailable, unverified, no price or locality) stay.
"""
import sys, os

EDITS = {
    'routes/crmFacebookPages.js': [
        ("// Staff tokens only (board tokens refused), checked against the live agents\n"
         "// row. Staged rollout: administrators, plus agents whose\n"
         "// feature_entitlements.facebook_pages is true. Every action is scoped to the\n",
         "// Any signed-in agent, checked against the live agents row: administrators,\n"
         "// staff, and Board accounts that still have board access. An agent can be\n"
         "// switched off with feature_entitlements.facebook_pages = false. Every action is scoped to the\n"),
        ("  if (payload.aud === 'board') return res.status(403).json({ error: 'Board account — no access to Facebook publishing.' })\n", ""),
        ("    const { rows: [a] } = await db.query(`SELECT id, role, active, name, username, feature_entitlements FROM agents WHERE id=$1`, [payload.id])\n",
         "    if (!payload || typeof payload !== 'object' || payload.kind || payload.ownerContactId || (payload.aud !== undefined && payload.aud !== 'crm' && payload.aud !== 'board')) {\n"
         "      return res.status(401).json({ error: 'Session invalid or expired' })\n"
         "    }\n"
         "    const { rows: [a] } = await db.query(`SELECT id, role, active, board_access, name, username, feature_entitlements FROM agents WHERE id=$1`, [payload.id])\n"),
        ("    if (!['admin', 'agent'].includes(a.role)) return res.status(403).json({ error: 'No access to Facebook publishing' })\n"
         "    const entitled = a.role === 'admin' || (a.feature_entitlements && a.feature_entitlements.facebook_pages === true)\n",
         "    if (!['admin', 'agent', 'board'].includes(a.role)) return res.status(403).json({ error: 'No access to Facebook publishing' })\n"
         "    if ((a.role === 'board' || payload.aud === 'board') && !a.board_access) return res.status(401).json({ error: 'Account inactive' })\n"
         "    const entitled = a.role === 'admin' || !(a.feature_entitlements && a.feature_entitlements.facebook_pages === false)\n"),
        ("    if (!entitled) return res.status(403).json({ error: 'Facebook publishing is not enabled for your account yet.', kind: 'not_entitled' })\n",
         "    if (!entitled) return res.status(403).json({ error: 'Facebook publishing is switched off for your account.', kind: 'not_entitled' })\n"),
    ],
    'services/facebookPages/property.js': [
        ("// Authorisation: an agent may publish the listings they list\n"
         "// (properties.listed_by_agent_id); an ARGUS administrator may publish any\n"
         "// agency listing. Publishing never changes listing ownership or attribution.\n",
         "// Authorisation: any signed-in agent may publish any publishable agency listing\n"
         "// on their own Page, except another agent's exclusive listing while the\n"
         "// exclusivity runs. Publishing never changes listing ownership or attribution.\n"),
        ("  p.lifecycle_state, p.verification_status, p.verified_at, p.listed_by_agent_id, p.last_confirmed_available_at, p.created_at`",
         "  p.lifecycle_state, p.verification_status, p.verified_at, p.listed_by_agent_id, p.last_confirmed_available_at, p.created_at,\n"
         "  (p.is_exclusive IS TRUE AND (p.exclusive_until IS NULL OR p.exclusive_until > NOW())) AS exclusive_now`"),
        ("  if (agent.role !== 'admin' && Number(row.listed_by_agent_id) !== Number(agent.id)) out.push({ code: 'not_yours', message: 'Only the listing agent can publish this property to Facebook.' })\n",
         "  if (agent.role !== 'admin' && row.exclusive_now && Number(row.listed_by_agent_id) !== Number(agent.id)) out.push({ code: 'not_yours', message: 'This is another agent\\'s exclusive listing, so only they can publish it to Facebook.' })\n"),
    ],
}


def main():
    if len(sys.argv) < 2:
        print(__doc__); return 2
    root = sys.argv[1]; check = '--check' in sys.argv[2:]
    out = {}
    for rel, edits in EDITS.items():
        path = os.path.join(root, rel)
        raw = open(path, 'rb').read(); work = raw.decode('utf-8')
        for old, new in edits:
            if old not in work and '\n' in old and old.replace('\n', '\r\n') in work:
                old, new = old.replace('\n', '\r\n'), new.replace('\n', '\r\n')
            if new and new in work:
                print(f'REFUSE {rel}: already applied'); return 1
            n = work.count(old)
            if n != 1:
                print(f'REFUSE {rel}: anchor found {n}x: {old[:70]!r}'); return 1
            work = work.replace(old, new)
        out[path] = work.encode('utf-8'); print(f'ok   {rel}: {len(edits)} edit(s), {len(out[path]) - len(raw):+d} bytes')
    if check:
        print('CHECK ONLY, nothing written'); return 0
    for path, data in out.items():
        open(path, 'wb').write(data)
    print('APPLIED'); return 0


if __name__ == '__main__':
    sys.exit(main())
