'use strict'
// ============================================================================
// services/propertySourceFetch.js — read-only, permission-gated HTTP for
// Property Source Sync (Claude, 2026-11-09).
//
// SSRF policy: HTTPS only, adapter host allow-list re-checked on EVERY
// redirect hop, DNS resolved by us and the socket pinned to the vetted address
// (a rebinding answer between check and connect cannot slip through), private /
// loopback / link-local / CGNAT / multicast / reserved ranges refused, byte and
// time budgets, robots.txt respected. No cookies, no credentials, no images.
// ============================================================================
const https = require('https')
const dns = require('dns')
const net = require('net')
const { canonicalUrl, adapterFor } = require('./propertySourceAdapters')

const USER_AGENT = 'ARGUS-SourceSync/1.0 (2906 Real Estate; authorised read-only listing sync)'
const MAX_BYTES = 3_000_000
const TIMEOUT_MS = 15_000
const MAX_REDIRECTS = 3

function isPublicAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number)
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false
    if (a === 100 && b >= 64 && b <= 127) return false // CGNAT
    if (a === 169 && b === 254) return false
    if (a === 172 && b >= 16 && b <= 31) return false
    if (a === 192 && b === 168) return false
    if (a === 192 && b === 0) return false
    if (a === 198 && (b === 18 || b === 19)) return false
    return true
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase()
    if (v === '::' || v === '::1') return false
    if (v.startsWith('::ffff:')) return isPublicAddress(v.slice(7))
    if (/^f[cd]/.test(v) || /^fe[89ab]/.test(v) || v.startsWith('ff') || v.startsWith('2001:db8') || v.startsWith('64:ff9b')) return false
    return true
  }
  return false
}

// lookup() hook used by the socket itself: whatever resolves is vetted here,
// at connect time, so DNS rebinding after an earlier check cannot bypass it.
function vettedLookup(hostname, options, callback) {
  if (typeof options === 'function') { callback = options; options = {} }
  if (net.isIP(hostname)) return callback(new Error('IP-literal hosts are not allowed'))
  dns.lookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
    if (err) return callback(err)
    const ok = (addresses || []).filter(a => isPublicAddress(a.address))
    if (!ok.length || ok.length !== addresses.length) return callback(new Error('Source host resolves to a non-public address'))
    const pick = ok[0]
    if (options && options.all) return callback(null, [pick])
    return callback(null, pick.address, pick.family)
  })
}

function requestOnce(url, { headers = {}, lookup = vettedLookup } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const req = https.request({
      protocol: 'https:', hostname: u.hostname, port: 443, path: u.pathname + u.search, method: 'GET',
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml;q=0.9,text/plain;q=0.8', ...headers },
      lookup, timeout: TIMEOUT_MS, agent: false,
    }, res => {
      const chunks = []; let size = 0
      res.on('data', c => { size += c.length; if (size > MAX_BYTES) { req.destroy(new Error('Response exceeded byte budget')); return } chunks.push(c) })
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }))
      res.on('error', reject)
    })
    req.on('timeout', () => req.destroy(new Error('Source request timed out')))
    req.on('error', reject)
    req.end()
  })
}

// Follows at most MAX_REDIRECTS hops; every hop must canonicalise onto the same
// adapter's allow-list. Returns { status, body, etag, lastModified, finalUrl }.
async function fetchAllowed(url, adapterKey, { conditional = {}, request = requestOnce } = {}) {
  let current = canonicalUrl(url, adapterKey)
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const headers = {}
    if (hop === 0 && conditional.etag) headers['If-None-Match'] = conditional.etag
    if (hop === 0 && conditional.lastModified) headers['If-Modified-Since'] = conditional.lastModified
    const r = await request(current, { headers })
    if ([301, 302, 303, 307, 308].includes(r.status)) {
      if (hop === MAX_REDIRECTS) throw new Error('Redirect limit exceeded')
      const loc = r.headers.location
      if (!loc) throw new Error('Redirect without location')
      current = canonicalUrl(loc, adapterKey, current) // throws for off-list hosts / schemes
      continue
    }
    if (r.status === 304) return { status: 304, body: '', finalUrl: current }
    if (r.status === 401 || r.status === 403 || r.status === 429) throw new Error(`Provider refused access (HTTP ${r.status}); backing off`)
    if (r.status < 200 || r.status >= 300) throw new Error(`Provider returned HTTP ${r.status}`)
    const type = String(r.headers['content-type'] || '')
    if (type && !/text\/html|application\/xhtml|text\/plain/i.test(type)) throw new Error(`Unexpected content type ${type}`)
    return { status: r.status, body: r.body, etag: r.headers.etag || null, lastModified: r.headers['last-modified'] || null, finalUrl: current }
  }
  throw new Error('Redirect error')
}

// Minimal robots.txt evaluation (User-agent groups, longest-match Allow/Disallow).
function robotsAllows(text, path, agent = 'ARGUS-SourceSync') {
  const groups = []; let cur = null; let lastWasAgent = false
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim(); if (!line) continue
    const [k, ...rest] = line.split(':'); const key = k.trim().toLowerCase(); const val = rest.join(':').trim()
    if (key === 'user-agent') { if (!lastWasAgent || !cur) { cur = { agents: [], rules: [] }; groups.push(cur) } cur.agents.push(val.toLowerCase()); lastWasAgent = true; continue }
    lastWasAgent = false
    if (!cur) continue
    if (key === 'allow' || key === 'disallow') cur.rules.push({ allow: key === 'allow', path: val })
  }
  const mine = groups.filter(g => g.agents.some(a => a !== '*' && agent.toLowerCase().includes(a)))
  const group = mine.length ? mine : groups.filter(g => g.agents.includes('*'))
  let best = null
  for (const g of group) for (const r of g.rules) {
    if (!r.path) continue
    const pattern = new RegExp('^' + r.path.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$'))
    if (pattern.test(path) && (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow))) best = r
  }
  return !best || best.allow
}

async function checkRobots(adapterKey, paths, { request = requestOnce } = {}) {
  const a = adapterFor(adapterKey)
  const r = await request(`https://${a.canonicalHost}/robots.txt`, {})
  if (r.status >= 500) throw new Error('robots.txt unavailable (5xx); stopping')
  if ([301, 302, 303, 307, 308].includes(r.status)) throw new Error('robots.txt redirects; manual review required')
  if (r.status === 401 || r.status === 403) throw new Error('robots.txt access restricted')
  if (r.status === 404) return true // absence of robots rules — NOT a business permission
  for (const p of paths) if (!robotsAllows(r.body, p)) throw new Error(`Disallowed by robots.txt: ${p}`)
  return true
}

module.exports = { USER_AGENT, isPublicAddress, vettedLookup, fetchAllowed, robotsAllows, checkRobots, requestOnce }
