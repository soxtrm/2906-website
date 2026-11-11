'use strict'
// Local, throw-away Postgres 16 for the owner-link tests (Claude, 2026-11-11).
// Starts an embedded server on 127.0.0.1, loads a SCHEMA-ONLY dump of production
// (no production rows) and stops. Nothing here talks to the VPS.
//
//   node test/helpers/localDb.js start   → init + start + load schema (idempotent)
//   node test/helpers/localDb.js stop
//
// Env: ARGUS_TEST_PGDIR (data dir), ARGUS_SCHEMA_SQL (schema-only pg_dump),
//      ARGUS_TEST_PGPORT (default 55439). Needs `embedded-postgres` + `pg` on NODE_PATH.
const fs = require('fs')
const path = require('path')

const PORT = Number(process.env.ARGUS_TEST_PGPORT || 55439)
const DIR = process.env.ARGUS_TEST_PGDIR
const SCHEMA = process.env.ARGUS_SCHEMA_SQL
const DB = 'argus_test'

async function main() {
  const cmd = process.argv[2]
  if (!DIR) throw new Error('ARGUS_TEST_PGDIR is required')
  const EmbeddedPostgres = require('embedded-postgres').default || require('embedded-postgres')
  const pg = new EmbeddedPostgres({ databaseDir: DIR, user: 'test', password: 'test', port: PORT, persistent: true, initdbFlags: ['--encoding=UTF8', '--locale=C'] })
  if (cmd === 'stop') { await pg.stop().catch(() => {}); return }
  const fresh = !fs.existsSync(path.join(DIR, 'PG_VERSION'))
  if (fresh) await pg.initialise()
  await pg.start()
  if (fresh) {
    if (!SCHEMA) throw new Error('ARGUS_SCHEMA_SQL is required for the first start')
    await pg.createDatabase(DB)
    const { Client } = require('pg')
    const c = new Client({ host: '127.0.0.1', port: PORT, user: 'test', password: 'test', database: DB })
    await c.connect()
    // pg_dump output minus psql meta-commands and the one PG 17-only setting;
    // run as one simple-protocol batch.
    const sql = fs.readFileSync(SCHEMA, 'utf8').split(/\r?\n/).filter(l => !l.startsWith('\\') && !/^SET transaction_timeout/.test(l)).join('\n')
    await c.query(sql)
    await c.query('SET search_path TO public')
    const { rows: [{ n }] } = await c.query(`SELECT COUNT(*)::int AS n FROM information_schema.tables WHERE table_schema='public'`)
    await c.end()
    console.log(`schema loaded: ${n} tables`)
  }
  console.log(`postgres ready on 127.0.0.1:${PORT}/${DB}`)
  // Keep the server alive for the test run; the parent stops it with "stop" or by killing this process.
  if (cmd === 'serve') await new Promise(() => {})
  process.exit(0)
}
main().catch(err => { console.error(err.message); process.exit(1) })
