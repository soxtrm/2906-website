'use strict'

function normaliseLimit(value, fallback = 50) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.min(500, Math.floor(parsed))
}

function messageId(message) {
  return String(message?.id || message?.key?.id || message?._data?.key?.id || '')
}

async function collectMessagePages({
  limit = 50,
  pageSize = 10,
  fetchMediaPage,
  fetchTextPage,
  onMediaError = () => {},
  onTextError = () => {},
}) {
  if (typeof fetchMediaPage !== 'function') throw new TypeError('fetchMediaPage is required')
  if (typeof fetchTextPage !== 'function') throw new TypeError('fetchTextPage is required')

  const wanted = normaliseLimit(limit)
  const chunkSize = Math.max(1, Math.min(10, normaliseLimit(pageSize, 10)))

  async function fetchRange(offset, count) {
    try {
      const page = await fetchMediaPage({ offset, limit: count })
      if (!Array.isArray(page)) throw new TypeError('WAHA media page is not an array')
      return page
    } catch (error) {
      onMediaError({ offset, limit: count, error })

      // One bad/expired image must not discard every older image in the
      // gallery. Narrow only the failing range until the exact message is
      // isolated, while every healthy sibling message keeps its media.
      if (count > 1) {
        const leftSize = Math.ceil(count / 2)
        const rightSize = count - leftSize
        const left = await fetchRange(offset, leftSize)
        const right = rightSize ? await fetchRange(offset + leftSize, rightSize) : []
        return [...left, ...right]
      }

      // Preserve the text/timestamp for a single irretrievable media message.
      // Only that one attachment is absent; the rest of the gallery remains.
      try {
        const page = await fetchTextPage({ offset, limit: 1 })
        if (!Array.isArray(page)) throw new TypeError('WAHA text page is not an array')
        return page
      } catch (textError) {
        onTextError({ offset, limit: 1, error: textError })
        return []
      }
    }
  }

  const collected = []
  const seen = new Set()
  let emptyPages = 0
  for (let offset = 0; offset < wanted; offset += chunkSize) {
    const count = Math.min(chunkSize, wanted - offset)
    const page = await fetchRange(offset, count)
    // P0 2026-11-12: WAHA drops non-content messages AFTER paging, so a page of 10
    // regularly comes back with 8 or 9. Treating that as the end of the history cut
    // every read at the first short page (79 of 349 messages in OLGA UPLOADS) and
    // large albums lost photos and their description. Only empty pages end the read.
    if (!page.length) { if (++emptyPages >= 2) break; continue }
    emptyPages = 0

    for (let index = 0; index < page.length; index++) {
      const message = page[index]
      const id = messageId(message)
      const key = id || `fallback:${message?.timestamp || message?._data?.t || ''}:${offset + index}`
      if (seen.has(key)) continue
      seen.add(key)
      collected.push(message)
    }
  }

  return collected.slice(0, wanted)
}

module.exports = { collectMessagePages, normaliseLimit }
