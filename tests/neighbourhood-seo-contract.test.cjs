const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const areasDir = path.join(root, 'public', 'link-marketplace', 'areas')
const hub = fs.readFileSync(path.join(root, 'public', 'link-marketplace', 'index.html'), 'utf8')
const sitemap = fs.readFileSync(path.join(root, 'public', 'neighbourhood-sitemap.xml'), 'utf8')
const files = fs.readdirSync(areasDir).filter(file => file.endsWith('.html')).sort()

assert.equal(files.length, 54, 'expected the current 54 neighbourhood editions')

const titles = new Map()
const descriptions = new Map()
const sitemapUrls = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map(match => match[1])

assert.equal(sitemapUrls.length, files.length, 'sitemap and published edition count must match')
assert.equal(new Set(sitemapUrls).size, sitemapUrls.length, 'sitemap URLs must be unique')

function value(html, patterns) {
  for (const pattern of patterns) {
    const match = html.match(pattern)
    if (match) return match[1].trim()
  }
  return ''
}

for (const file of files) {
  const html = fs.readFileSync(path.join(areasDir, file), 'utf8')
  const publicUrl = `https://www.2906.estate/link-marketplace/areas/${file}`
  const publicPath = `/link-marketplace/areas/${file}`
  const title = value(html, [/<title>([\s\S]*?)<\/title>/i])
  const description = value(html, [
    /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["'][^>]*>/i,
    /<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["'][^>]*>/i,
  ])
  const canonical = value(html, [
    /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["'][^>]*>/i,
    /<link[^>]+href=["']([^"']+)["'][^>]+rel=["']canonical["'][^>]*>/i,
  ])

  assert.ok(title, `${file}: missing title`)
  assert.ok(description, `${file}: missing meta description`)
  assert.equal(canonical, publicUrl, `${file}: canonical must match its public URL`)
  assert.equal((html.match(/<h1\b/gi) || []).length, 1, `${file}: must contain exactly one H1`)
  assert.equal((html.match(/<iframe\b/gi) || []).length, 0, `${file}: maps must not load an initial iframe`)
  assert.ok(/application\/ld\+json/i.test(html), `${file}: missing structured data`)
  assert.ok(sitemapUrls.includes(publicUrl), `${file}: missing from neighbourhood sitemap`)
  assert.ok(hub.includes(`href="${publicPath}"`), `${file}: missing from neighbourhood hub`)

  const imageTags = [...html.matchAll(/<img\b[^>]*>/gi)].map(match => match[0])
  assert.ok(imageTags.length > 0, `${file}: missing a locality image`)
  for (const imageTag of imageTags) {
    const src = value(imageTag, [/\bsrc=["']([^"']+)["']/i])
    assert.ok(src.startsWith('../assets/'), `${file}: locality images must be self-hosted`)
    assert.ok(/\bwidth=["']\d+["']/i.test(imageTag), `${file}: image width is required`)
    assert.ok(/\bheight=["']\d+["']/i.test(imageTag), `${file}: image height is required`)
    assert.ok(fs.existsSync(path.resolve(areasDir, src)), `${file}: image asset does not exist: ${src}`)
  }

  titles.set(title, [...(titles.get(title) || []), file])
  descriptions.set(description, [...(descriptions.get(description) || []), file])
}

for (const [title, matchingFiles] of titles) {
  assert.equal(matchingFiles.length, 1, `duplicate title '${title}' in ${matchingFiles.join(', ')}`)
}
for (const [description, matchingFiles] of descriptions) {
  assert.equal(matchingFiles.length, 1, `duplicate description in ${matchingFiles.join(', ')}`)
}

console.log('Neighbourhood SEO, sitemap, hub and image contract passed for all 54 editions')
