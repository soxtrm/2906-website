// NEXUS CTO report generator (lead developer session, 21 Nov 2026).
// Merges the curated register (docs/cto/features.json) with LIVE evidence and writes
// docs/cto/NEXUS_CTO_STATUS.json + docs/cto/NEXUS_CTO_STATUS.md. Run after every release:
//   node ops/cto/cto-report.cjs
// Evidence: Vercel alias -> deployment -> commit per host; HTTP health probes; NEXUS Booking current release;
// ARGUS backend packages (latest backup markers, names + time only); Benestates release; repository head.
// The repo is public: only release names, commits, status codes and timings are written. No hosts' IPs,
// no paths on servers, no secrets, no personal data.
const fs = require('fs'), path = require('path'), { execSync } = require('child_process')
const ROOT = path.resolve(__dirname, '..', '..')
const reg = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/cto/features.json'), 'utf8'))
const TEAM = 'team_0up4qnkl9UNhd83TueDmBOY0'
// SSH targets come from a local file outside the repo (~/.nexus-cto-hosts.json: {"vps":"user@host","ben":"user@host"}) or env
let HOSTS = {}; try { HOSTS = JSON.parse(fs.readFileSync(path.join(require('os').homedir(), '.nexus-cto-hosts.json'), 'utf8')) } catch { /* evidence from SSH is skipped */ }
const VPS = process.env.CTO_VPS || HOSTS.vps, BEN = process.env.CTO_BEN || HOSTS.ben
const sh = (cmd, t = 20000) => { try { return execSync(cmd, { timeout: t, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() } catch { return null } }
const ssh = (host, cmd) => !host ? null : sh(`ssh -o BatchMode=yes -o ConnectTimeout=8 ${host} "${cmd.replace(/"/g, '\\"')}"`)

async function vercel() {
  let token; try { token = JSON.parse(fs.readFileSync(path.join(process.env.APPDATA || '', 'com.vercel.cli', 'Data', 'auth.json'), 'utf8')).token } catch { return {} }
  const A = { authorization: `Bearer ${token}` }; const out = {}
  for (const h of ['nexusstudios.one', 'nexusmp.one', 'crm.2906.estate', 'www.2906.estate', 'nexussync.one']) {
    try {
      const al = await (await fetch(`https://api.vercel.com/v4/aliases/${h}?teamId=${TEAM}`, { headers: A })).json()
      const d = await (await fetch(`https://api.vercel.com/v13/deployments/${al.deploymentId}?teamId=${TEAM}`, { headers: A })).json()
      out[h] = { deployment: al.deploymentId, commit: (d.meta && d.meta.gitCommitSha || '').slice(0, 7) || null, branch: d.meta && d.meta.gitCommitRef || null, deployedAt: d.createdAt ? new Date(d.createdAt).toISOString() : null }
    } catch { out[h] = { error: 'unavailable' } }
  }
  return out
}
async function probe(url) {
  const t0 = Date.now()
  try { const r = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(15000) }); return { url, status: r.status, ms: Date.now() - t0 } } catch { return { url, status: 0, ms: Date.now() - t0 } }
}

;(async () => {
  const [deploys, probes] = await Promise.all([vercel(), Promise.all([
    'https://nexusstudios.one/marketplace', 'https://nexusstudios.one/api/marketplace/listings', 'https://nexusstudios.one/marketplace/rooms',
    'https://nexussync.one/owner', 'https://crm.2906.estate/crm/deal-rooms', 'https://www.2906.estate/', 'https://nexuslink.fit/',
    'https://api.2906.estate/api/properties', 'https://benestates.work/api/ben/work-health',
  ].map(probe))])
  const booking = (ssh(VPS, 'readlink -f /opt/nexusbooking/current') || '').split('/').pop() || null
  const argusPkgs = (ssh(VPS, 'cd /opt/2906-system/backups && for f in *-latest; do echo "$f $(basename $(cat $f))"; done') || '').split('\n').filter(Boolean)
    .map(l => { const [marker, bk] = l.split(' '); const m = (bk || '').match(/(\d{8}T\d{6}Z)$/); return { package: marker.replace(/-latest$/, ''), appliedAt: m ? m[1] : null } })
    .sort((a, b) => String(b.appliedAt).localeCompare(String(a.appliedAt)))
  const benRelease = ((ssh(BEN, 'readlink -f /opt/bestate-panel') || '').split('/').pop() || '').slice(0, 7) || null
  const head = sh('git -C "' + ROOT + '" rev-parse --short HEAD'), branch = sh('git -C "' + ROOT + '" rev-parse --abbrev-ref HEAD')
  const byProduct = {}
  for (const [k, p] of Object.entries(reg.products)) byProduct[k] = { ...p, deployment: p.host ? deploys[p.host] || null : null, features: reg.features.filter(f => f.product === k) }
  byProduct.booking.backendRelease = booking
  byProduct.argus.backendPackages = argusPkgs.slice(0, 20)
  byProduct.benestates.release = benRelease
  const counts = reg.features.reduce((m, f) => (m[f.status] = (m[f.status] || 0) + 1, m), {})
  const report = { generatedAt: new Date().toISOString(), generator: 'ops/cto/cto-report.cjs', repository: { name: 'soxtrm/2906-website', branch, head }, statusCounts: counts, health: probes, products: byProduct }
  fs.writeFileSync(path.join(ROOT, 'docs/cto/NEXUS_CTO_STATUS.json'), JSON.stringify(report, null, 2) + '\n')

  // readable counterpart: launch-readiness board first
  const L = []
  L.push(`# NEXUS CTO status`, ``, `Generated ${report.generatedAt} from live evidence by \`ops/cto/cto-report.cjs\` (repo ${branch} @ ${head}). Status values: ${reg.statusValues.join(', ')}. A build is not an end-to-end test; staging is not production verification.`, ``)
  L.push(`## Launch-readiness board`, ``, `| Product | Feature | Founder requirement | Status | User-facing test | Remaining blocker | Workstream |`, `|---|---|---|---|---|---|---|`)
  for (const f of reg.features) L.push(`| ${reg.products[f.product].name} | ${f.feature} | ${f.founder} | **${f.status}** | ${f.userTest || '-'} | ${f.blocker || '-'} | ${f.workstream} |`)
  L.push(``, `## Products`, ``, `| Product | URL | Live deployment | Commit | Deployed | Milestone |`, `|---|---|---|---|---|---|`)
  for (const p of Object.values(byProduct)) {
    const d = p.deployment || {}
    const rel = p.backendRelease ? `Booking release ${p.backendRelease}` : p.release ? `release ${p.release}` : d.deployment || '-'
    L.push(`| ${p.name} | ${p.url} | ${rel} | ${d.commit || '-'} | ${d.deployedAt ? d.deployedAt.slice(0, 16).replace('T', ' ') : '-'} | ${p.milestone} |`)
  }
  L.push(``, `## Health (probed at generation)`, ``, `| URL | HTTP | ms |`, `|---|---|---|`)
  for (const h of probes) L.push(`| ${h.url} | ${h.status || 'down'} | ${h.ms} |`)
  L.push(``, `## ARGUS backend packages (latest first)`, ``, ...argusPkgs.slice(0, 12).map(p => `- ${p.package} · ${p.appliedAt || '-'}`), ``)
  L.push(`## Next actions`, ``, ...reg.features.filter(f => f.next).map(f => `- **${reg.products[f.product].name} · ${f.feature}:** ${f.next}`), ``)
  fs.writeFileSync(path.join(ROOT, 'docs/cto/NEXUS_CTO_STATUS.md'), L.join('\n'))
  console.log(`written docs/cto/NEXUS_CTO_STATUS.{json,md}: ${reg.features.length} features, ${probes.filter(p => p.status >= 200 && p.status < 400).length}/${probes.length} probes ok`)
})()
