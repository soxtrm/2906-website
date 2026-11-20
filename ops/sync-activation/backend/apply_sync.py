#!/usr/bin/env python3
"""NEXUS SYNC activation (2026-11-19): mount the SYNC account service and the CRM
SYNC inbox, and consume "SYNC verify CODE" messages on ARGUS Main before any
other WhatsApp handling. New files are copied by deploy.sh; this applies the
three anchor edits to live files, keeping each file's line endings.

  apply_sync.py <backend_dir> [--check]
"""
import sys, os

HOOK = """    // ── SYNC. mobile confirmation (Claude, 2026-11-19) ──────────────────
    // "SYNC verify CODE" sent to ARGUS Main confirms an owner's number for
    // nexussync.one. Consumed here, before contact accounting, AI replies or
    // lead intake see it. Other sessions and other texts pass through unchanged.
    if ((event === 'message' || event === 'message.any') && payload.fromMe !== true
        && require('../services/syncAccount').WA_RE.test(String(payload.body || ''))) {
      const _syncHandled = await require('../services/syncAccount').handleWhatsAppVerify({ session, payload })
        .catch(e => { log.warn('sync verify failed', { err: e.message }); return true })
      if (_syncHandled) return
    }

"""

EDITS = {
    'index.js': [
        ('app.use("/api/nexus-link/v1", require("./routes/nexusLinkService"))',
         'app.use("/api/nexus-link/v1", require("./routes/nexusLinkService"))\n'
         '// NEXUS SYNC (Claude, 2026-11-19): owner accounts for nexussync.one (signed, server-to-server) and the CRM SYNC inbox.\n'
         'app.use("/api/sync-account/v1", require("./routes/syncAccountService"))\n'
         'app.use("/api/crm/sync-inbox", require("./routes/crmSyncInbox"))'),
    ],
    'routes/webhook.js': [
        ('    // ── Inactivity clock (2026-09-22) ',
         HOOK + '    // ── Inactivity clock (2026-09-22) '),
    ],
}
MARK = {'index.js': 'routes/syncAccountService', 'routes/webhook.js': 'SYNC. mobile confirmation'}

def main():
    root = sys.argv[1]; check = '--check' in sys.argv[2:]
    out = {}
    for rel, edits in EDITS.items():
        path = os.path.join(root, rel)
        raw = open(path, 'rb').read()
        crlf = b'\r\n' in raw
        work = raw.decode('utf-8')
        if MARK[rel] in work: print(f'REFUSE {rel}: already applied'); return 1
        for old, new in edits:
            old_n = old.replace('\n', '\r\n') if crlf else old
            new_n = new.replace('\n', '\r\n') if crlf else new
            n = work.count(old_n)
            if n != 1: print(f'REFUSE {rel}: anchor found {n}x: {old[:70]!r}'); return 1
            work = work.replace(old_n, new_n)
        out[path] = work.encode('utf-8')
        print(f'ok   {rel}: {len(edits)} edit(s), +{len(out[path]) - len(raw)} bytes, {"CRLF" if crlf else "LF"}')
    if check: print('CHECK ONLY, nothing written'); return 0
    for path, data in out.items(): open(path, 'wb').write(data)
    print('APPLIED'); return 0

if __name__ == '__main__':
    sys.exit(main())
