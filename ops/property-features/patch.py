#!/usr/bin/env python3
"""NEXUS adaptive property features (2026-11-21). Usage: patch.py <backend dir> [--check]

index.js                      mounts /api/crm/property-features (staff only)
services/nexusBridge.js       public inventory carries each listing's confirmed/evidenced features
routes/nexusBridge.js         GET /api/nexus/features: the standard feature dictionary (labels, groups, aliases)
routes/syncAccountService.js  owner routes: features of a home, suggestions, set, remove
Exact anchors, line-ending aware, already-applied spots skipped, nothing written unless every anchor matches."""
import sys, os
root = sys.argv[1]; check = '--check' in sys.argv
EDITS = {
    'index.js': [
        ('app.use("/api/crm/sync-inbox", require("./routes/crmSyncInbox"))\n',
         'app.use("/api/crm/sync-inbox", require("./routes/crmSyncInbox"))\n'
         'app.use("/api/crm/property-features", require("./routes/crmPropertyFeatures"))\n'),
    ],
    'services/nexusBridge.js': [
        ("  return {meta:{generated_at:new Date().toISOString(),mode:'live',taxonomyVersion:taxonomy.version,firewall_leaks:[],coordinate_policy:'locality centroid only'},properties:result.rows.map(r=>projection(r,places)).filter(r=>r.listable)}\n",
         "  const properties=result.rows.map(r=>projection(r,places)).filter(r=>r.listable)\n"
         "  // confirmed / evidenced property features with their provenance (2026-11-21); a failure never blocks the inventory\n"
         "  await require('./propertyFeatures').attachPublic(properties).catch(()=>{for(const p of properties)p.features=p.features||[]})\n"
         "  return {meta:{generated_at:new Date().toISOString(),mode:'live',taxonomyVersion:taxonomy.version,firewall_leaks:[],coordinate_policy:'locality centroid only'},properties}\n"),
    ],
    'routes/nexusBridge.js': [
        ("router.get('/taxonomy',(_req,res)=>res.json(bridge.taxonomy))\n",
         "router.get('/taxonomy',(_req,res)=>res.json(bridge.taxonomy))\n"
         "router.get('/features',handle(async(_req,res)=>res.json(await require('../services/propertyFeatures').publicDictionary())))\n"),
    ],
    'routes/syncAccountService.js': [
        ("router.post('/delegates', send(async req => SD.list(await me(req))))\n",
         "router.post('/delegates', send(async req => SD.list(await me(req))))\n"
         "// Property features (2026-11-21): own homes, or representatives with 'edit'\n"
         "const PF = require('../services/propertyFeatures')\n"
         "router.post('/owner/features', send(async req => PF.ownerList(S, await me(req), { propertyId: req.body?.propertyId })))\n"
         "router.post('/owner/features/suggest', send(async req => { await me(req); return PF.suggest(String(req.body?.text || '').slice(0, 120)) }))\n"
         "router.post('/owner/features/set', send(async req => PF.ownerSet(S, await me(req), { propertyId: req.body?.propertyId, key: req.body?.key, text: req.body?.text, value: req.body?.value, note: req.body?.note })))\n"
         "router.post('/owner/features/remove', send(async req => PF.ownerRemove(S, await me(req), { propertyId: req.body?.propertyId, key: req.body?.key })))\n"),
    ],
}
plan = []
for rel, edits in EDITS.items():
    path = os.path.join(root, rel)
    text = open(path, 'rb').read().decode('utf-8')
    for old, new in edits:
        if any(text.count(new.replace('\n', nl)) == 1 for nl in ('\n', '\r\n')): print(f'already applied in {rel}'); continue
        hit = None
        for nl in ('\n', '\r\n'):
            o, n = old.replace('\n', nl), new.replace('\n', nl)
            c = text.count(o)
            if c == 1: hit = (o, n); break
            if c > 1: print(f'ANCHOR {c}x in {rel}: {old[:70]!r}'); sys.exit(1)
        if not hit: print(f'ANCHOR 0x in {rel}: {old[:70]!r}'); sys.exit(1)
        text = text.replace(hit[0], hit[1])
    plan.append((path, text))
if check: print('anchors ok'); sys.exit(0)
for path, text in plan:
    open(path, 'wb').write(text.encode('utf-8')); print('patched', path)
