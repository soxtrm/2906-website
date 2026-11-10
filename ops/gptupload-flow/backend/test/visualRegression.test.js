'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '../../../../artifacts/image-pipeline-regression')
const fixtures = ['living-room', 'bedroom', 'kitchen', 'bathroom', 'unfinished']
const sha = buffer => crypto.createHash('sha256').update(buffer).digest('hex')
const dimensions = buffer => ({ width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) })

for (const name of fixtures) {
  test(`visual fixture ${name}: original, GPT and PLUS are readable distinct PNGs`, () => {
    const original = fs.readFileSync(path.join(root, 'original', `${name}.png`))
    const gpt = fs.readFileSync(path.join(root, 'gptupload', `${name}.png`))
    const plusName = name === 'living-room' ? 'living-room-v2.png' : `${name}.png`
    const plus = fs.readFileSync(path.join(root, 'plusupload', plusName))
    for (const image of [original, gpt, plus]) {
      assert.equal(image.readUInt32BE(0), 0x89504e47)
      const size = dimensions(image)
      assert.ok(size.width >= 1024 && size.height >= 768)
      assert.ok(image.length > 100_000)
    }
    assert.notEqual(sha(original), sha(gpt), 'conservative output must be transformed')
    assert.notEqual(sha(original), sha(plus), 'premium output must be transformed')
    assert.notEqual(sha(gpt), sha(plus), 'premium must not alias conservative output')
  })
}
