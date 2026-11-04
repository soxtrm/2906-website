'use strict'

function replyFingerprint(value) {
  return String(value || '').toLowerCase()
    .replace(/\b(?:good\s+(?:morning|afternoon|evening)|hello|hi|hey|thanks?|thank you|kind regards|regards)\b/g, ' ')
    .replace(/\b(?:the|a|an|our|your|my|please|just|i|you|have|ve|for)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim()
}

function nearDuplicate(a, b) {
  const x = replyFingerprint(a)
  const y = replyFingerprint(b)
  if (!x || !y) return x === y
  if (x === y) return true
  const xs = new Set(x.split(' ')); const ys = new Set(y.split(' '))
  const intersection = [...xs].filter(token => ys.has(token)).length
  const union = new Set([...xs, ...ys]).size
  return union > 0 && intersection / union >= 0.82
}

module.exports = { nearDuplicate, replyFingerprint }
