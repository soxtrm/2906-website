// Stage test (throwaway container, no network, temporary profile): the browser starts although the profile carries
// a lock from another container; a same-host lock of a process that is not ours is left alone (files only).
const fs = require('fs'), path = require('path'), os = require('os')
const PROFILE = process.env.FB_PROFILE_DIR
let fails = 0
const ok = (n, c, i = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${i ? '  — ' + i : ''}`); if (!c) fails++ }
;(async () => {
  fs.rmSync(PROFILE, { recursive: true, force: true }); fs.mkdirSync(PROFILE, { recursive: true })
  const fb = require('/app/services/fbBrowser')
  // 1. a clean first launch writes a lock of THIS host
  let b = await fb.getBrowser(); ok('clean launch works', !!b && b.isConnected())
  const own = fs.readlinkSync(path.join(PROFILE, 'SingletonLock'))
  ok('the lock names this host', own.startsWith(os.hostname() + '-'), own)
  await fb.closeBrowser()
  // 2. a lock left by another container (what production has since 16:52): launch must recover by itself
  for (const f of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) try { fs.unlinkSync(path.join(PROFILE, f)) } catch {}
  fs.symlinkSync('7feeecd6f350-926', path.join(PROFILE, 'SingletonLock'))
  let err = null
  try { b = await fb.getBrowser() } catch (e) { err = e }
  ok('launch with a foreign-container lock recovers and starts', !err && !!b && b.isConnected(), err ? err.message.split('\n')[0] : '')
  ok('the foreign lock was replaced by this host\'s lock', fs.readlinkSync(path.join(PROFILE, 'SingletonLock')).startsWith(os.hostname() + '-'))
  await fb.closeBrowser()
  console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED'); process.exit(fails ? 1 : 0)
})().catch(e => { console.log('CRASH', e.message); process.exit(1) })
