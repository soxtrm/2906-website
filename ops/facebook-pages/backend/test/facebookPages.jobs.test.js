'use strict'
// BullMQ wiring against a THROW-AWAY Redis (TEST_REDIS_HOST): the queue and its
// processor live together, a pending attempt is queued once, a finished job id
// can be reused for the next attempt, and stop() closes cleanly.
process.env.NO_DB = '1'
const test = require('node:test')
const assert = require('node:assert/strict')
const { load, loadBase } = require('./helpers/overlay')

test('facebook-page-publish queue: dedupe per attempt, processor runs, clean stop', async () => {
  if (!process.env.TEST_REDIS_HOST) throw new Error('TEST_REDIS_HOST (throw-away Redis) is required')
  const publisher = load('services/facebookPages/publisher')
  const seen = []
  publisher.run = async id => { seen.push(id) }
  publisher.sweep = async () => ({})
  const jobs = load('services/facebookPages/jobs')
  jobs.start()
  await jobs.enqueue(42, 300, 0)
  await jobs.enqueue(42, 300, 0)          // same attempt while pending: ignored
  await new Promise(r => setTimeout(r, 2500))
  assert.deepEqual(seen, [42])
  await jobs.enqueue(42, 0, 0)            // finished job ids are released (removeOnComplete)
  await jobs.enqueue(43, 0, 1)
  await new Promise(r => setTimeout(r, 2500))
  assert.deepEqual(seen.sort(), [42, 42, 43])
  await jobs.stop()
  const { QUEUES } = loadBase('queues')
  await Promise.all(Object.values(QUEUES).map(qq => qq.close()))
})
