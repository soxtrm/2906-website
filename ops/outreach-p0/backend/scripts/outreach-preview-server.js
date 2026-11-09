'use strict'
// Kev, 2026-10-29: UI preview of the outreach automation against the REAL
// routes/crm.js + services on the isolated test database. WhatsApp, queues
// and Telegram are the harness stubs: nothing can be sent. Fake numbers only.
//   node scripts/outreach-preview-server.js   (inside argus-outreach-testnet)
process.env.JWT_SECRET = process.env.JWT_SECRET || require('crypto').randomBytes(24).toString('hex')
const H = require('../test/helpers/harness')
const express = require(require.resolve('express', { paths: ['/app/node_modules'] }))
const jwt = require(require.resolve('jsonwebtoken', { paths: ['/app/node_modules'] }))
const Templates = H.load('services/outreachTemplates')
const Pace = H.load('services/outreachPace')
const P = H.load('services/outreachPlanner')

async function seed() {
  await H.reset()
  await H.db.query(`TRUNCATE pool_cursors`)
  await H.db.query(`INSERT INTO pool_cursors(pool, cursor_id) VALUES ('top', 0), ('bottom', 999999999)`)
  await Templates.ensureSeed()
  const towns = ['Sliema', 'Gzira', 'St Julians', 'Msida', 'Swieqi']
  const values = Array.from({ length: 400 }, (_, i) => `('3569900${String(i).padStart(4, '0')}', 'Preview Owner ${i}', 'new', '${towns[i % 5]}')`).join(',')
  await H.db.query(`INSERT INTO owner_contacts(phone_normalized, name, status, location) VALUES ${values}`)
  const kev = await H.account({ session: 'default', persona: 'kev', label: 'Kev Primary', phone: '35699000001' })
  const ced = await H.account({ session: 'Cedric', persona: 'cedric', phone: '35699000002' })
  const gab = await H.account({ session: 'Gabriela', persona: 'gabriela', phone: '35699000003' })
  await Pace.setAccountPace(kev.id, { min: 30, max: 40 })
  await Pace.setAccountPace(ced.id, { min: 33 })
  await P.setAutoEnabled(kev.id, true)
  await P.saveAllPrepared(kev.id)
  await P.setAutoEnabled(ced.id, true)
  // Engagement sample: older owners outside the pool range, 1–7 attempts.
  for (let i = 0; i < 24; i++) {
    const phone = `3569800${String(i).padStart(4, '0')}`
    await H.db.query(`INSERT INTO owner_contacts(phone_normalized, name, status, location) VALUES ($1,$2,$3,$4)`,
      [phone, `Past Owner ${i}`, i % 11 === 0 ? 'do_not_contact' : 'new', towns[i % 5]])
    const attempts = 1 + (i % 7)
    for (let a = 0; a < attempts; a++) {
      await H.db.query(`INSERT INTO outreach_log(phone, account_used, sent_at, replied) VALUES ($1,$2,NOW() - ($3 || ' days')::interval,$4)`,
        [phone, i % 2 ? 'default' : 'Cedric', String(90 - a * 9), i % 5 === 0 && a === attempts - 1])
    }
  }
  await H.db.query(`DELETE FROM agents WHERE username = 'preview-admin'`).catch(() => {})
  const agent = (await H.db.query(
    `INSERT INTO agents(username, email, name, role, active, password_hash) VALUES ('preview-admin','preview@example.invalid','Preview Admin','admin',TRUE,'x') RETURNING id`)).rows[0]
  return jwt.sign({ id: agent.id, username: 'preview-admin', role: 'admin', aud: 'crm' }, process.env.JWT_SECRET, { expiresIn: '6h' })
}

seed().then(token => {
  const app = express()
  app.use(express.json())
  app.use('/api/crm', require('../routes/crm'))
  app.listen(3901, '0.0.0.0', () => console.log(`PREVIEW_READY token=${token}`))
}).catch(err => { console.error(err); process.exit(1) })
