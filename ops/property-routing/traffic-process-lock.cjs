'use strict'

const fs = require('node:fs')

const pidIsAlive = pid => {
  try { process.kill(pid, 0); return true } catch (error) { return error.code === 'EPERM' }
}

function acquireProcessLock(file, ownerPid = process.pid) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(file, 'wx', 0o640)
      fs.writeFileSync(fd, `${ownerPid}\n`)
      fs.fsyncSync(fd)
      return fd
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      let owner = null
      try { owner = Number.parseInt(fs.readFileSync(file, 'utf8').trim(), 10) } catch {}
      if (Number.isInteger(owner) && pidIsAlive(owner)) return null
      try { fs.unlinkSync(file) } catch {}
    }
  }
  return null
}

function releaseProcessLock(file, fd) {
  if (fd == null) return
  fs.closeSync(fd)
  try { fs.unlinkSync(file) } catch {}
}

module.exports = { acquireProcessLock, releaseProcessLock }
