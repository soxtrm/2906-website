// Read-only Vercel audit: deployments of every project with source, git commit, branch, dirty flag and creator;
// project git links, deploy hooks and aliases. The CLI token is read from its auth file and never printed.
const fs = require('fs'); const path = require('path')
const auth = [path.join(process.env.APPDATA || '', 'com.vercel.cli', 'Data', 'auth.json'), path.join(process.env.LOCALAPPDATA || '', 'com.vercel.cli', 'Data', 'auth.json')].find(p => fs.existsSync(p))
const token = JSON.parse(fs.readFileSync(auth, 'utf8')).token
const api = async p => { const r = await fetch(`https://api.vercel.com${p}`, { headers: { authorization: `Bearer ${token}` } }); return r.json() }
;(async () => {
  const projects = (await api('/v9/projects?limit=50')).projects || []
  for (const pr of projects) {
    const full = await api(`/v9/projects/${pr.id}`)
    console.log(`\n== project ${pr.name}  git link: ${full.link ? `${full.link.type} ${full.link.org || ''}/${full.link.repo || ''} (deployHooks: ${(full.link.deployHooks || []).length})` : 'none'}`)
    const deps = (await api(`/v6/deployments?projectId=${pr.id}&limit=40&since=${Date.now() - 4 * 86400e3}`)).deployments || []
    for (const d of deps) {
      const m = d.meta || {}
      console.log([new Date(d.created).toISOString().slice(5, 16), d.uid, d.target || 'preview', d.source || '-', d.creator?.username || '-',
        `sha=${(m.gitCommitSha || m.githubCommitSha || '').slice(0, 8) || '-'}`, `ref=${m.gitCommitRef || m.githubCommitRef || '-'}`, `dirty=${m.gitDirty ?? '-'}`,
        `msg=${String(m.gitCommitMessage || m.githubCommitMessage || '').split('\n')[0].slice(0, 70)}`].join('  '))
    }
  }
})().catch(e => { console.error('audit failed:', e.message); process.exit(1) })
