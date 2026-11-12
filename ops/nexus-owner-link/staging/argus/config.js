'use strict'
// Staging stand-in for the production config.js: only what db.js reads, taken
// from STAGING_* variables. Production variables are never read here.
module.exports = {
  nodeEnv: 'staging',
  db: {
    host: process.env.STAGING_DB_HOST,
    port: Number(process.env.STAGING_DB_PORT || 5432),
    database: process.env.STAGING_DB_NAME,
    user: process.env.STAGING_DB_USER,
    password: process.env.STAGING_DB_PASSWORD,
  },
}
