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
const editionLinks = new Map()
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
  if (/createElement\(["']iframe["']\)/i.test(html)) {
    assert.ok(/frame\.title\s*=/i.test(html), `${file}: deferred map iframe needs an accessible title`)
    assert.ok(/frame\.loading\s*=\s*["']eager["']/i.test(html), `${file}: clicked map must load immediately`)
    assert.ok(
      /frame\.referrerPolicy\s*=\s*["']strict-origin-when-cross-origin["']/i.test(html),
      `${file}: deferred map iframe needs the strict referrer policy`,
    )
    assert.ok(/\{\s*once\s*:\s*true\s*\}/i.test(html), `${file}: map button must create only one iframe`)
  } else {
    assert.ok(/edition-map\.mjs/i.test(html), `${file}: missing deferred 2D map implementation`)
  }
  const mapButtons = [...html.matchAll(/<button\b[^>]*(?:class=["'][^"']*\bmap-open\b[^"']*["']|id=["']load-map["'])[^>]*>/gi)]
    .map(match => match[0])
  assert.equal(mapButtons.length, 1, `${file}: must expose one map control`)
  assert.equal(
    value(mapButtons[0], [/\baria-controls=["']([^"']+)["']/i]),
    'area-map',
    `${file}: map control must identify its map region`,
  )
  const mapRegion = value(html, [/(<div\b[^>]*\bid=["']area-map["'][^>]*>)/i])
  assert.ok(mapRegion, `${file}: missing map region`)
  assert.ok(/\brole=["']region["']/i.test(mapRegion), `${file}: map container must be an explicit region`)
  assert.ok(/\baria-label=["'][^"']+["']/i.test(mapRegion), `${file}: map region needs an accessible label`)
  assert.ok(/\bhidden\b/i.test(mapRegion), `${file}: map region must stay hidden before user intent`)
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
    assert.ok(/\bfetchpriority=["']high["']/i.test(imageTag), `${file}: hero image must receive high fetch priority`)
    assert.ok(fs.existsSync(path.resolve(areasDir, src)), `${file}: image asset does not exist: ${src}`)
  }

  const relatedEditions = [...html.matchAll(/href=["']([^"']+\.html(?:#[^"']*)?)["']/gi)]
    .map(match => match[1].split('#')[0].split('/').at(-1))
    .filter(target => files.includes(target) && target !== file)
  editionLinks.set(file, new Set(relatedEditions))

  titles.set(title, [...(titles.get(title) || []), file])
  descriptions.set(description, [...(descriptions.get(description) || []), file])
}

for (const [title, matchingFiles] of titles) {
  assert.equal(matchingFiles.length, 1, `duplicate title '${title}' in ${matchingFiles.join(', ')}`)
}
for (const [description, matchingFiles] of descriptions) {
  assert.equal(matchingFiles.length, 1, `duplicate description in ${matchingFiles.join(', ')}`)
}

for (const file of files) {
  assert.ok(editionLinks.get(file).size > 0, `${file}: needs a contextual link to another distinct edition`)
  const inbound = files.filter(source => editionLinks.get(source).has(file))
  assert.ok(inbound.length > 0, `${file}: needs an inbound contextual link from another distinct edition`)
}

console.log('Neighbourhood SEO, sitemap, hub, image and deferred-map accessibility contract passed for all 54 editions')
