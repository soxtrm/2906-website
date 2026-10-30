const { Pool } = require('pg')
const config = require('./config')
const log = require('./logger')

// ── Lazy module-level singleton ─────────────────────────────────────────
//
// The pool used to be instantiated at module load time and could be
// permanently ended by ANY caller that invoked db.end() or pool.end()
// (e.g. one-off scripts under scripts/, the test runner, etc.). Once
// ended, every subsequent db.query(...) call failed with
//   "Cannot use a pool after calling end on the pool"
// which killed 30+ admin commands until the process restarted.
//
// We now defer Pool construction until first use and intercept .end()
// so the singleton is never torn down except at process shutdown
// (handled explicitly in index.js). The exported `db` is a Proxy that
// transparently delegates every property access to a real Pool, and
// re-creates the pool if the previous one was ended.
//
// External code keeps using `db.query(...)`, `db.connect(...)`, etc.
// exactly as before. db.end() becomes a safe no-op (logged at warn).
// ─────────────────────────────────────────────────────────────────────────

let _pool = null

function _buildPool() {
  const p = new Pool({
    host: config.db.host,
    port: config.db.port,
    database: config.db.database,
    user: config.db.user,
    password: config.db.password,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  })
  p.on('error', (err) => {
    log.error('Unexpected DB pool error', err)
  })
  return p
}

function _getPool() {
  if (!_pool || _pool.ended) {
    if (_pool && _pool.ended) {
      log.warn('db: pool was ended; recreating (lazy singleton)')
    }
    _pool = _buildPool()
  }
  return _pool
}

// Pre-warm at module load so the first request doesn't pay the cost —
// but stay recoverable: if the pool ever gets ended, the proxy rebuilds
// it on next access.
_getPool()

const _handler = {
  get(_target, prop, _receiver) {
    const pool = _getPool()
    const value = pool[prop]
    return typeof value === 'function' ? value.bind(pool) : value
  },
  set(_target, prop, value) {
    const pool = _getPool()
    pool[prop] = value
    return true
  },
}

const db = new Proxy({}, _handler)

// Expose end() as a safe no-op so scripts / test runners that call
// db.end() don't kill the live singleton. index.js still owns process
// shutdown.
db.end = async function _safeEnd() {
  log.warn('db.end() called but pool is protected; ignoring (singleton survives)')
  return undefined
}

module.exports = db
