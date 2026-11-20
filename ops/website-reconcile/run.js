'use strict'
// Runs the reconcile module from /tmp as if it lived in /app/services. APPLY=1 writes; MAX=null lifts the
// change limit for one reviewed run.
const fs = require('fs'); const Module = require('module')
const file = '/app/services/websiteReconcile.js'
const m = new Module(file); m.filename = file; m.paths = Module._nodeModulePaths('/app/services')
m._compile(fs.readFileSync('/tmp/websiteReconcile.js', 'utf8'), file)
const opts = { apply: process.env.APPLY === '1' }
if (process.env.MAX === 'null') opts.maxChanges = null
m.exports.reconcile(opts)
  .then(s => { console.log(JSON.stringify(s)); setTimeout(() => process.exit(0), 200) })
  .catch(e => { console.log('FAILED', e.message); process.exit(1) })
