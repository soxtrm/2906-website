'use strict'
// ============================================================================
// services/facebookPages/publisher.js — create, run, reconcile and manage
// Facebook Page publications.
//
// Safety rules:
//  • The database row is the source of truth; the queue only says "look at
//    row N now". A row is claimed with a conditional UPDATE, so two workers or
//    a retried job can never both publish it.
//  • The idempotency key is UNIQUE. A double click, a retried HTTP request or a
//    retried job returns the same publication instead of creating a new post.
//  • Photo uploads (unpublished) are safe to retry. The final feed/photo call
//    is not: feed_requested_at is written first, and if the answer is lost the
//    row goes to "reconciling" and we look for the post on the Page instead of
//    posting again.
//  • Permanent errors (permissions, expired login, bad media) are never
//    retried automatically. Rate limits wait for Meta's own estimate.
//  • Success is shown only once Meta returned a post id; the permalink comes
//    from Meta, never constructed.
// ============================================================================
const graph = require('./graph')
const store = require('./store')
const connect = require('./connect')
const propertySvc = require('./property')
const content = require('./content')
const secrets = require('./secrets')

const { db } = store
const MAX_ATTEMPTS = 5
const RECONCILE_GIVE_UP_MIN = 15

let enqueueImpl = async () => {}
function setEnqueue(fn) { enqueueImpl = fn }
async function enqueue(pub, delayMs = 0) { try { await enqueueImpl(pub.id, delayMs, pub.attempt_count || 0) } catch { /* the sweeper picks it up */ } }

function err(status, message, extra = {}) { return Object.assign(new Error(message), { status, ...extra }) }

// ── serialisation (never exposes credential ids or tokens) ───────────────────
const STATE_LABEL = { draft: 'Draft', queued: 'Queued', publishing: 'Publishing', reconciling: 'Confirming', published: 'Published', failed: 'Failed', reconnect_required: 'Reconnect required', removed: 'Removed', needs_review: 'Check needed', cancelled: 'Cancelled' }
function shape(r) {
  if (!r) return null
  const c = r.content || {}
  return {
    id: Number(r.id), propertyId: r.property_id, propertyRef: r.property_ref, pageRowId: r.page_row_id ? Number(r.page_row_id) : null,
    pageName: r.page_name, publicationType: r.publication_type, state: r.state, stateLabel: STATE_LABEL[r.state] || r.state, trigger: r.trigger,
    message: c.message || '', images: c.images || [], link: c.link || null, language: c.language || 'en', template: c.template || null,
    postId: r.post_id, permalinkUrl: r.permalink_url, publishedAt: r.published_at, lastCheckedAt: r.last_checked_at,
    error: r.last_error_message ? { kind: r.last_error_kind, message: r.last_error_message } : null,
    nextAttemptAt: r.next_attempt_at, attemptCount: r.attempt_count, replacesId: r.replaces_id ? Number(r.replaces_id) : null,
    editedAt: c.edited_at || null, createdAt: r.created_at, updatedAt: r.updated_at,
    canEdit: r.state === 'published' && !!r.post_id, canDelete: r.state === 'published' && !!r.post_id,
    canRetry: ['failed', 'reconnect_required', 'needs_review', 'cancelled'].includes(r.state) && !r.post_id,
  }
}

async function agentRow(agentId) {
  const { rows: [a] } = await db.query(
    `SELECT id, role, active, name, username, display_name, alias, public_phone, whatsapp_phone, email, color_hex FROM agents WHERE id=$1`, [agentId])
  return a || null
}

// ── draft (preview) ──────────────────────────────────────────────────────────
async function draft(agent, propertyId, opts = {}) {
  const prefs = await store.preferences(agent.id)
  const full = await agentRow(agent.id)
  const p = await propertySvc.load(agent, propertyId)
  const language = content.LANGS.includes(opts.language) ? opts.language : prefs.language
  const emojis = opts.emojis === undefined ? prefs.use_emojis : !!opts.emojis
  const includeContact = opts.includeContact === undefined ? prefs.include_contact : !!opts.includeContact
  const includeLink = opts.includeLink === undefined ? prefs.include_link : !!opts.includeLink
  let templateId = opts.templateId || (prefs.default_template_id ? String(prefs.default_template_id) : 'classic')
  let custom = null
  if (/^\d+$/.test(String(templateId))) {
    const { rows: [t] } = await db.query(`SELECT * FROM agent_facebook_templates WHERE id=$1 AND agent_id=$2`, [Number(templateId), agent.id])
    if (t) custom = t.body; else templateId = 'classic'
  }
  const link = includeLink && p.link ? p.link.url : null
  const message = p.blockers.length ? '' : content.render({ template: templateId, custom, facts: p.facts, link, language, emojis, cta: opts.cta || prefs.call_to_action, includeContact, agent: full || {} })
  const { rows: existing } = await db.query(
    `SELECT * FROM agent_facebook_publications WHERE property_id=$1 AND agent_id=$2 ORDER BY created_at DESC LIMIT 20`, [p.row.id, agent.id])
  return {
    property: {
      id: p.facts.id, ref: p.facts.ref, type: p.facts.type, town: p.facts.town, bedrooms: p.facts.bedrooms, bathrooms: p.facts.bathrooms,
      rent: p.facts.rent, sale: p.facts.sale, availableStatus: p.facts.availableStatus, availableDate: p.facts.availableDate,
    },
    images: p.images, imagesAllowed: p.imagesAllowed, imagesReason: p.imagesReason, maxImages: propertySvc.MAX_IMAGES,
    link, linkKind: p.link ? p.link.kind : null, message, language, templateId: String(templateId), emojis, includeContact, includeLink,
    blockers: p.blockers, publications: existing.map(shape),
  }
}

// ── create ───────────────────────────────────────────────────────────────────
function publicationType(images, link) {
  if (images.length > 1) return 'multi_photo'
  if (images.length === 1) return 'photo'
  return link ? 'link' : 'text'
}

async function create(agent, body = {}) {
  connect.requireConfigured()
  const clientKey = String(body.idempotencyKey || '')
  if (!/^[A-Za-z0-9_-]{8,100}$/.test(clientKey)) throw err(400, 'Missing request id. Reload the page and try again.')
  const idempotencyKey = `manual:${agent.id}:${clientKey}`
  const { rows: [already] } = await db.query(`SELECT * FROM agent_facebook_publications WHERE idempotency_key=$1`, [idempotencyKey])
  if (already) return { publication: shape(already), replayed: true }

  const page = await store.ownedPage(agent.id, Number(body.pageRowId))
  if (!page || page.status === 'disconnected') throw err(404, 'Choose one of your connected Facebook Pages.')
  if (page.connection_state !== 'active') throw err(409, 'Your Facebook connection needs to be renewed. Reconnect Facebook, then publish again.', { kind: 'auth' })
  if (!page.can_publish || page.status !== 'active') throw err(409, page.status_reason || 'ARGUS cannot post on this Page.', { kind: 'permission' })

  const p = await propertySvc.load(agent, body.propertyId)
  if (p.blockers.length) throw err(409, p.blockers[0].message, { blockers: p.blockers })

  const images = Array.isArray(body.images) ? body.images.map(String) : []
  if (images.length > propertySvc.MAX_IMAGES) throw err(400, `Choose at most ${propertySvc.MAX_IMAGES} photos.`)
  if (images.length && !p.imagesAllowed) throw err(409, p.imagesReason)
  if (new Set(images).size !== images.length) throw err(400, 'The same photo was selected twice.')
  for (const u of images) if (!p.allImageUrls.has(u)) throw err(400, 'One of the selected photos does not belong to this listing.')

  const full = await agentRow(agent.id)
  const token = secrets.randomToken(9)
  const baseLink = body.includeLink === false || !p.link ? null : p.link.url
  const link = baseLink ? propertySvc.withAttribution(baseLink, token) : null
  let message = String(body.message || '').replace(/\r/g, '').trim()
  if (baseLink && message.includes(baseLink)) message = message.split(baseLink).join(link)
  else if (link && images.length) message = `${message}\n\n🔗 ${link}`
  const check = content.validateMessage(message, { agent: full || {} })
  if (!check.ok) throw err(400, check.message)

  const { rows: dupes } = await db.query(
    `SELECT * FROM agent_facebook_publications WHERE property_id=$1 AND page_row_id=$2 AND state IN ('queued','publishing','reconciling','published') ORDER BY created_at DESC`,
    [p.row.id, page.id])
  if (dupes.length && body.confirmDuplicate !== true) {
    throw err(409, `This property is already ${dupes[0].state === 'published' ? 'published' : 'being published'} on ${page.page_name}. Publish again anyway?`,
      { kind: 'duplicate', existing: dupes.map(shape) })
  }
  let replacesId = null
  if (body.replacesId) {
    const { rows: [old] } = await db.query(`SELECT id FROM agent_facebook_publications WHERE id=$1 AND agent_id=$2`, [Number(body.replacesId), agent.id])
    if (!old) throw err(404, 'The post to replace was not found.')
    replacesId = old.id
  }
  const snapshot = {
    message, images, link, link_kind: p.link ? p.link.kind : null, language: content.LANGS.includes(body.language) ? body.language : 'en',
    template: body.templateId ? String(body.templateId).slice(0, 40) : null, property: { ref: p.facts.ref, town: p.facts.town },
  }
  const { rows: [row] } = await db.query(
    `INSERT INTO agent_facebook_publications (property_id, property_ref, agent_id, page_row_id, page_id, page_name, publication_type, state, trigger,
            idempotency_key, content, attribution_token, replaces_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'queued',$8,$9,$10::jsonb,$11,$12)
     ON CONFLICT (idempotency_key) DO NOTHING RETURNING *`,
    [p.row.id, p.row.ref, agent.id, page.id, page.page_id, page.page_name, publicationType(images, link), replacesId ? 'replacement' : 'manual',
     idempotencyKey, JSON.stringify(snapshot), token, replacesId])
  if (!row) {
    const { rows: [again] } = await db.query(`SELECT * FROM agent_facebook_publications WHERE idempotency_key=$1`, [idempotencyKey])
    return { publication: shape(again), replayed: true }
  }
  await store.audit(agent, 'facebook_publish_requested', { propertyId: p.row.id, ref: p.row.ref, details: { publication_id: Number(row.id), page_row_id: Number(page.id), type: row.publication_type, images: images.length } })
  await enqueue(row)
  return { publication: shape(row), replayed: false }
}

// ── run (job processor) ──────────────────────────────────────────────────────
async function setState(id, state, fields = {}) {
  const sets = ['state=$2', 'updated_at=NOW()']
  const vals = [id, state]
  for (const [k, v] of Object.entries(fields)) { vals.push(v); sets.push(`${k}=$${vals.length}`) }
  const { rows: [r] } = await db.query(`UPDATE agent_facebook_publications SET ${sets.join(', ')} WHERE id=$1 RETURNING *`, vals)
  return r
}

async function failWith(pub, e, agent) {
  const kind = e && e.kind ? e.kind : 'unknown'
  const msg = (e && (e.userMessage || (e.status && e.message))) || graph.MESSAGES.unknown
  if (kind === 'auth') {
    if (pub.page_row_id) {
      const { rows: [pg] } = await db.query(`SELECT connection_id FROM agent_facebook_pages WHERE id=$1`, [pub.page_row_id])
      if (pg) await connect.markReconnectRequired(pg.connection_id, msg)
    }
    const r = await setState(pub.id, 'reconnect_required', { last_error_kind: kind, last_error_message: msg, last_error_code: e.code ? String(e.code) : null, next_attempt_at: null })
    if (agent) await store.audit(agent, 'facebook_publish_failed', { propertyId: pub.property_id, ref: pub.property_ref, details: { publication_id: Number(pub.id), kind } })
    return r
  }
  if (kind === 'permission' && pub.page_row_id) {
    await db.query(`UPDATE agent_facebook_pages SET status='missing_permission', can_publish=FALSE, enabled=FALSE, auto_publish=FALSE, is_default=FALSE, status_reason=$2, updated_at=NOW() WHERE id=$1`, [pub.page_row_id, msg])
  }
  if ((kind === 'rate_limit' || kind === 'policy' || (kind === 'transient' && !e.uncertain)) && pub.attempt_count < MAX_ATTEMPTS) {
    const delaySec = e.retryAfterSec || Math.min(3600, 60 * 2 ** Math.max(0, pub.attempt_count - 1))
    const r = await setState(pub.id, 'queued', { last_error_kind: kind, last_error_message: msg, last_error_code: e.code ? String(e.code) : null, next_attempt_at: new Date(Date.now() + delaySec * 1000) })
    await enqueue(r, delaySec * 1000)
    return r
  }
  const r = await setState(pub.id, 'failed', { last_error_kind: kind, last_error_message: msg, last_error_code: e && e.code ? String(e.code) : null, next_attempt_at: null })
  if (agent) await store.audit(agent, 'facebook_publish_failed', { propertyId: pub.property_id, ref: pub.property_ref, details: { publication_id: Number(pub.id), kind } })
  return r
}

async function withRetry(fn, tries = 3) {
  let last
  for (let i = 0; i < tries; i++) {
    try { return await fn() } catch (e) {
      last = e
      if (!(e instanceof graph.GraphError) || e.kind !== 'transient') throw e
      await new Promise(r => setTimeout(r, 400 * 3 ** i))
    }
  }
  throw last
}

async function run(publicationId) {
  const { rows: [claimed] } = await db.query(
    `UPDATE agent_facebook_publications SET state='publishing', attempt_count=attempt_count+1, updated_at=NOW()
      WHERE id=$1 AND state='queued' AND (next_attempt_at IS NULL OR next_attempt_at <= NOW() + INTERVAL '5 seconds') RETURNING *`, [publicationId])
  if (!claimed) {
    const { rows: [cur] } = await db.query(`SELECT * FROM agent_facebook_publications WHERE id=$1`, [publicationId])
    if (cur && cur.state === 'reconciling') return reconcile(cur)
    return cur ? shape(cur) : null
  }
  const pub = claimed
  const agent = await agentRow(pub.agent_id)
  try {
    if (!agent || !agent.active) return shape(await setState(pub.id, 'cancelled', { last_error_kind: 'agent_inactive', last_error_message: 'The agent account is no longer active.' }))
    const page = await store.ownedPage(pub.agent_id, pub.page_row_id)
    if (!page || page.status === 'disconnected') return shape(await setState(pub.id, 'cancelled', { last_error_kind: 'disconnected', last_error_message: 'Facebook was disconnected before this post was published.' }))
    if (page.connection_state !== 'active') return shape(await failWith(pub, { kind: 'auth', userMessage: graph.MESSAGES.auth }, agent))
    if (!page.can_publish || page.status !== 'active') return shape(await failWith(pub, { kind: 'permission', userMessage: page.status_reason || graph.MESSAGES.permission }, agent))
    if (pub.trigger === 'auto_verified') {
      const prefs = await store.preferences(pub.agent_id)
      if (!prefs.auto_publish_enabled || !page.auto_publish) return shape(await setState(pub.id, 'cancelled', { last_error_kind: 'auto_off', last_error_message: 'Automatic publishing was switched off.' }))
    }
    // The listing may have changed since the agent pressed Publish.
    const p = await propertySvc.load(agent, pub.property_id, { createLink: false })
    if (p.blockers.length) return shape(await setState(pub.id, 'failed', { last_error_kind: 'listing', last_error_message: p.blockers[0].message }))
    const c = pub.content || {}
    const images = Array.isArray(c.images) ? c.images : []
    if (images.length && !p.imagesAllowed) return shape(await setState(pub.id, 'failed', { last_error_kind: 'listing', last_error_message: p.imagesReason }))
    const token = await store.pageToken(page)
    if (!token) return shape(await failWith(pub, { kind: 'auth', userMessage: graph.MESSAGES.auth }, agent))

    let mediaFbids = []
    if (pub.publication_type === 'multi_photo') {
      for (let i = 0; i < images.length; i++) {
        try { mediaFbids.push(await withRetry(() => graph.uploadUnpublishedPhoto(token, page.page_id, images[i]))) } catch (e) {
          if (e.kind === 'invalid_media') e.userMessage = `Facebook could not use photo ${i + 1} of ${images.length}. Remove it or choose another photo, then publish again. Nothing was posted.`
          throw e
        }
      }
      await db.query(`UPDATE agent_facebook_publications SET media_fbids=$2, updated_at=NOW() WHERE id=$1`, [pub.id, mediaFbids])
    }
    await db.query(`UPDATE agent_facebook_publications SET feed_requested_at=NOW(), updated_at=NOW() WHERE id=$1`, [pub.id])
    let postId
    if (pub.publication_type === 'photo') postId = (await graph.publishPhoto(token, page.page_id, images[0], c.message)).postId
    else postId = (await graph.publishFeed(token, page.page_id, { message: c.message, link: pub.publication_type === 'link' ? c.link : null, mediaFbids })).postId
    if (!postId) throw Object.assign(new graph.GraphError({ kind: 'transient', uncertain: true, userMessage: graph.MESSAGES.transient }))
    return shape(await markPublished(pub, token, postId, agent))
  } catch (e) {
    if (e instanceof graph.GraphError && e.uncertain) {
      const r = await setState(pub.id, 'reconciling', { last_error_kind: 'uncertain', last_error_message: 'Waiting for Facebook to confirm the post.', next_attempt_at: new Date(Date.now() + 45000) })
      await enqueue(r, 45000)
      return shape(r)
    }
    if (e instanceof graph.GraphError) return shape(await failWith(pub, e, agent))
    return shape(await failWith(pub, { kind: 'unknown', userMessage: e.status ? e.message : graph.MESSAGES.unknown }, agent))
  }
}

async function markPublished(pub, token, postId, agent) {
  let permalink = null
  try { const post = await graph.getPost(token, postId); permalink = post && post.permalink_url ? post.permalink_url : null } catch { /* filled by the next status check */ }
  const r = await setState(pub.id, 'published', {
    post_id: String(postId), permalink_url: permalink, published_at: new Date(), last_checked_at: new Date(),
    last_error_kind: null, last_error_message: null, last_error_code: null, next_attempt_at: null,
  })
  if (agent) await store.audit(agent, 'facebook_published', { propertyId: pub.property_id, ref: pub.property_ref, details: { publication_id: Number(pub.id), post_id: String(postId), page_row_id: Number(pub.page_row_id), type: pub.publication_type } })
  return r
}

const norm = s => String(s || '').replace(/\s+/g, ' ').trim()

// A feed call whose answer was lost: find the post on the Page instead of posting twice.
async function reconcile(pub) {
  const agent = await agentRow(pub.agent_id)
  const page = await store.ownedPage(pub.agent_id, pub.page_row_id)
  const giveUp = async () => shape(await setState(pub.id, 'needs_review', {
    last_error_kind: 'unconfirmed', next_attempt_at: null,
    last_error_message: 'Facebook did not confirm this post. Check your Page: if the post is not there, publish it again.',
  }))
  if (!page || page.connection_state !== 'active') return giveUp()
  const token = await store.pageToken(page)
  if (!token) return giveUp()
  const since = Math.floor(new Date(pub.feed_requested_at || pub.updated_at).getTime() / 1000) - 120
  try {
    const posts = await graph.recentPosts(token, page.page_id, since)
    const want = norm(pub.content && pub.content.message)
    const hit = posts.find(p => norm(p.message) === want)
    if (hit) return shape(await markPublished(pub, token, hit.id, agent))
  } catch { /* fall through to retry or give up */ }
  const ageMin = (Date.now() - new Date(pub.feed_requested_at || pub.updated_at).getTime()) / 60000
  if (ageMin > RECONCILE_GIVE_UP_MIN) return giveUp()
  const r = await setState(pub.id, 'reconciling', { next_attempt_at: new Date(Date.now() + 90000) })
  await enqueue(r, 90000)
  return shape(r)
}

// ── management ───────────────────────────────────────────────────────────────
async function owned(agent, id) {
  const { rows: [r] } = await db.query(`SELECT * FROM agent_facebook_publications WHERE id=$1 AND agent_id=$2`, [Number(id), agent.id])
  if (!r) throw err(404, 'Publication not found.')
  return r
}
async function tokenFor(agent, pub) {
  const page = await store.ownedPage(agent.id, pub.page_row_id)
  if (!page || page.status === 'disconnected') throw err(409, 'This Page is no longer connected to ARGUS.')
  if (page.connection_state !== 'active') throw err(409, 'Your Facebook connection needs to be renewed. Reconnect Facebook first.', { kind: 'auth' })
  const token = await store.pageToken(page)
  if (!token) throw err(409, 'Reconnect Facebook first.', { kind: 'auth' })
  return { page, token }
}

async function list(agent, { propertyId = null, limit = 50, before = null } = {}) {
  const vals = [agent.id]
  let where = 'agent_id=$1'
  if (propertyId) { vals.push(Number(propertyId)); where += ` AND property_id=$${vals.length}` }
  if (before) { vals.push(Number(before)); where += ` AND id < $${vals.length}` }
  vals.push(Math.min(Math.max(Number(limit) || 50, 1), 200))
  const { rows } = await db.query(`SELECT * FROM agent_facebook_publications WHERE ${where} ORDER BY id DESC LIMIT $${vals.length}`, vals)
  return rows.map(shape)
}
async function get(agent, id) { return shape(await owned(agent, id)) }

async function check(agent, id) {
  const pub = await owned(agent, id)
  if (!pub.post_id) return shape(pub)
  const { token } = await tokenFor(agent, pub)
  try {
    const post = await graph.getPost(token, pub.post_id)
    return shape(await setState(pub.id, pub.state === 'removed' ? 'removed' : 'published', { permalink_url: post.permalink_url || pub.permalink_url, last_checked_at: new Date() }))
  } catch (e) {
    if (e.kind === 'not_found') return shape(await setState(pub.id, 'removed', { removed_at: new Date(), last_checked_at: new Date(), last_error_kind: 'not_found', last_error_message: 'This post no longer exists on Facebook.' }))
    if (e.kind === 'auth') { await connect.markReconnectRequired(pub.page_row_id ? (await db.query(`SELECT connection_id FROM agent_facebook_pages WHERE id=$1`, [pub.page_row_id])).rows[0]?.connection_id : null, e.userMessage) }
    throw err(e.kind === 'auth' ? 409 : 502, e.userMessage || graph.MESSAGES.unknown, { kind: e.kind })
  }
}

async function updateText(agent, id, message) {
  const pub = await owned(agent, id)
  if (pub.state !== 'published' || !pub.post_id) throw err(409, 'Only published posts can be edited.')
  const text = String(message || '').replace(/\r/g, '').trim()
  const full = await agentRow(agent.id)
  const v = content.validateMessage(text, { agent: full || {} })
  if (!v.ok) throw err(400, v.message)
  const { token } = await tokenFor(agent, pub)
  try { await graph.updatePost(token, pub.post_id, text) } catch (e) {
    if (e.kind === 'not_editable' || e.kind === 'unknown') throw err(409, graph.MESSAGES.not_editable, { kind: 'not_editable', canReplace: true })
    if (e.kind === 'not_found') { await setState(pub.id, 'removed', { removed_at: new Date() }); throw err(409, graph.MESSAGES.not_found, { kind: 'not_found' }) }
    throw err(e.kind === 'auth' ? 409 : 502, e.userMessage || graph.MESSAGES.unknown, { kind: e.kind })
  }
  const next = { ...(pub.content || {}), message: text, edited_at: new Date().toISOString(), previous_message: (pub.content || {}).message }
  const r = await setState(pub.id, 'published', { content: JSON.stringify(next), last_checked_at: new Date() })
  await store.audit(agent, 'facebook_post_edited', { propertyId: pub.property_id, ref: pub.property_ref, details: { publication_id: Number(pub.id) } })
  return shape(r)
}

async function remove(agent, id, { confirm = false } = {}) {
  if (confirm !== true) throw err(400, 'Please confirm that you want to delete this post from Facebook.')
  const pub = await owned(agent, id)
  if (!pub.post_id || pub.state === 'removed') throw err(409, 'There is no published post to delete.')
  const { token } = await tokenFor(agent, pub)
  try { await graph.deletePost(token, pub.post_id) } catch (e) {
    if (e.kind !== 'not_found') {
      throw err(409, 'Facebook did not let ARGUS delete this post. Delete it on Facebook directly, then use "Check status" here to update ARGUS.', { kind: e.kind || 'unknown' })
    }
  }
  const r = await setState(pub.id, 'removed', { removed_at: new Date(), last_checked_at: new Date(), last_error_kind: null, last_error_message: null })
  await store.audit(agent, 'facebook_post_deleted', { propertyId: pub.property_id, ref: pub.property_ref, details: { publication_id: Number(pub.id), post_id: pub.post_id } })
  return shape(r)
}

async function retry(agent, id, { confirm = false } = {}) {
  const pub = await owned(agent, id)
  if (pub.post_id) throw err(409, 'This post was already published.')
  if (!['failed', 'reconnect_required', 'needs_review', 'cancelled'].includes(pub.state)) throw err(409, 'This post is already queued.')
  if (pub.state === 'needs_review' && confirm !== true) throw err(409, 'Facebook may already have published this post. Check your Page first, then confirm to publish again.', { kind: 'needs_confirmation' })
  const page = await store.ownedPage(agent.id, pub.page_row_id)
  if (!page || page.connection_state !== 'active' || !page.can_publish || page.status !== 'active') throw err(409, 'Reconnect Facebook or choose another Page first.', { kind: 'auth' })
  const r = await setState(pub.id, 'queued', { next_attempt_at: null, attempt_count: 0, last_error_kind: null, last_error_message: null, last_error_code: null, feed_requested_at: null, media_fbids: [] })
  await store.audit(agent, 'facebook_publish_retry', { propertyId: pub.property_id, ref: pub.property_ref, details: { publication_id: Number(pub.id) } })
  await enqueue(r)
  return shape(r)
}

// Periodic safety net: due retries, lost jobs and crashed runs.
async function sweep() {
  const { rows: stuck } = await db.query(
    `SELECT * FROM agent_facebook_publications WHERE state='publishing' AND updated_at < NOW() - INTERVAL '10 minutes' LIMIT 50`)
  for (const s of stuck) {
    if (s.feed_requested_at) await setState(s.id, 'reconciling', { next_attempt_at: new Date() })
    else await setState(s.id, 'queued', { next_attempt_at: new Date() })
  }
  const { rows: due } = await db.query(
    `SELECT * FROM agent_facebook_publications
      WHERE state IN ('queued','reconciling') AND COALESCE(next_attempt_at, updated_at + INTERVAL '2 minutes') <= NOW()
      ORDER BY id LIMIT 50`)
  for (const d of due) await enqueue(d)
  return { stuck: stuck.length, due: due.length }
}

module.exports = { draft, create, run, reconcile, list, get, check, updateText, remove, retry, sweep, setEnqueue, shape, publicationType }
