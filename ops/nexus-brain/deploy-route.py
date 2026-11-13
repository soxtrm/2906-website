"""Scoped Caddy route installation on the existing authorized Nexus host.
Usage: python3 deploy-route.py DEPLOYMENT_HOST EXPECTED_CADDY_SHA256
"""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from datetime import datetime, timezone

host, expected = sys.argv[1:]
if not re.fullmatch(r'2906-website-6zbi-[a-z0-9]+-kevinsony1-9794s-projects\.vercel\.app', host):
    raise SystemExit('Unexpected deployment host')
config = Path('/etc/caddy/Caddyfile')
before = config.read_bytes()
digest = lambda data: hashlib.sha256(data).hexdigest()
if digest(before) != expected:
    raise SystemExit('Caddy changed since audit; re-audit instead of overwriting')
text = before.decode('utf-8')
if '# BEGIN NEXUS BRAIN PRIVATE ROUTE' in text:
    raise SystemExit('Route already exists; do not repeat or overwrite')
marker = '\t@booking_private path /NexusBooking/data'
if text.count(marker) != 1:
    raise SystemExit('Canonical Nexus host marker is not unique')
block = f'''\t# BEGIN NEXUS BRAIN PRIVATE ROUTE
\t# Only this private presentation and its build assets use the pinned release.
\t@nexus_brain path /rating /rating/* /nexus-brain/* /_next/static/*
\thandle @nexus_brain {{
\t\treverse_proxy https://{host} {{
\t\t\theader_up Host {host}
\t\t}}
\t\theader X-Robots-Tag "noindex, nofollow, noarchive"
\t\theader Cache-Control "private, no-store"
\t\theader Referrer-Policy "no-referrer"
\t}}
\t# END NEXUS BRAIN PRIVATE ROUTE

'''
after = text.replace(marker, block + marker).encode('utf-8')
stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
backup = config.with_name(f'Caddyfile.before-nexus-brain-{stamp}')
candidate = config.with_name('Caddyfile.nexus-brain-candidate')
backup.write_bytes(before)
candidate.write_bytes(after)
subprocess.run(['caddy','validate','--config',str(candidate),'--adapter','caddyfile'],check=True,capture_output=True)
if config.read_bytes() != before:
    raise SystemExit('Concurrent Caddy edit before installation; original untouched')
os.replace(candidate,config)
reload = subprocess.run(['systemctl','reload','caddy'],capture_output=True)
if reload.returncode:
    config.write_bytes(before)
    subprocess.run(['systemctl','reload','caddy'],check=True,capture_output=True)
    raise SystemExit('Reload failed; original restored')
receipt = {'at':stamp,'deployment':host,'before_sha256':digest(before),'after_sha256':digest(after),'backup':str(backup),'scope':['/rating','/rating/*','/nexus-brain/*','/_next/static/*']}
Path('/etc/caddy/nexus-brain-release.json').write_text(json.dumps(receipt,indent=2))
print(json.dumps(receipt))
