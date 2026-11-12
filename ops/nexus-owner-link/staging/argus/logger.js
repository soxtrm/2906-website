'use strict'
// Staging logger: one JSON line per entry on stdout (collected by Docker, size-capped).
const line = level => (msg, meta) => console.log(JSON.stringify({ t: new Date().toISOString(), level, msg, ...(meta && typeof meta === 'object' ? { meta } : meta === undefined ? {} : { meta: String(meta) }) }))
const log = { info: line('info'), warn: line('warn'), error: line('error'), debug: () => {}, child: () => log }
module.exports = log
