// Release lock (2026-11-21): production deployments no longer take the live domains on their own.
// Before/after: autoAssignCustomDomains + which deployment serves each live domain (must not change).
// Re-enable:  node vercel_lock.cjs unlock
const fs = require('fs'); const path = require('path')
const auth = [path.join(process.env.APPDATA || '', 'com.vercel.cli', 'Data', 'auth.json'), path.join(process.env.LOCALAPPDATA || '', 'com.vercel.cli', 'Data', 'auth.json')].find(p => fs.existsSync(p))
const token = JSON.parse(fs.readFileSync(auth, 'utf8')).token
const api = async (p, init) => { const r = await fetch(`https://api.vercel.com${p}`, { ...init, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } }); return { status: r.status, body: await r.json() } }
const HOSTS = ['nexussync.one', 'www.nexussync.one', 'crm.2906.estate', 'www.2906.estate', 'nexusstudios.one', 'www.nexusstudios.one', 'nexusmp.one', 'www.nexusmp.one']
async function serving() { const out = {}; for (const h of HOSTS) { const r = await api(`/v4/aliases/${h}`); out[h] = r.body.deploymentId || r.body.error?.code } return out }
;(async () => {
  const unlock = process.argv[2] === 'unlock'
  const before = await serving()
  const p0 = (await api('/v9/projects/2906-website-6zbi')).body
  console.log('before: autoAssignCustomDomains =', p0.autoAssignCustomDomains)
  const r = await api('/v9/projects/2906-website-6zbi', { method: 'PATCH', body: JSON.stringify({ autoAssignCustomDomains: unlock }) })
  console.log('patch', r.status, r.body.error ? JSON.stringify(r.body.error) : '')
  const p1 = (await api('/v9/projects/2906-website-6zbi')).body
  console.log('after:  autoAssignCustomDomains =', p1.autoAssignCustomDomains)
  const after = await serving()
  for (const h of HOSTS) console.log(`${h.padEnd(22)} ${before[h]} ${before[h] === after[h] ? '(unchanged)' : '-> ' + after[h]}`)
})().catch(e => { console.error('failed:', e.message); process.exit(1) })
