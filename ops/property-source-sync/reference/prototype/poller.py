"""Explicitly permitted, polite, read-only source fetcher.

Requires operator acknowledgement and locally enabled source.
Does NOT copy photos, authorize their republication, or send any messages.
"""
from __future__ import annotations
from datetime import datetime, timezone
from urllib.parse import urlsplit,urljoin
from urllib.robotparser import RobotFileParser
import argparse,json,requests,time
from source_adapter import canonical_url, links_from_category, parse_detail, CATEGORIES
from store import connect, ingest_snapshot

USER_AGENT='ARGUS-SourceSync/0.1 (+integration contact through agency; manual authorized pilot)'
ALLOWED={'www.mynexthome.mt','mynexthome.mt'}


def get_same_origin(session, url, *, timeout=15, max_redirects=3):
    current=canonical_url(url)
    for i in range(max_redirects+1):
        r=session.get(current,timeout=timeout,allow_redirects=False,headers={'User-Agent':USER_AGENT})
        if r.status_code in (301,302,303,307,308):
            if i==max_redirects:raise RuntimeError('Redirect limit exceeded')
            current=canonical_url(urljoin(current,r.headers['Location']))
            continue
        r.raise_for_status()
        if len(r.content)>3_000_000:raise RuntimeError('HTML document exceeded byte budget')
        return r.text
    raise RuntimeError('Redirect error')


def verify_robots(session, path):
    # Treat robots as separate server policy; business permission still required.
    robots_url='https://www.mynexthome.mt/robots.txt'
    r=session.get(robots_url,timeout=12,allow_redirects=False,headers={'User-Agent':USER_AGENT})
    if r.status_code >= 500:raise RuntimeError('robots.txt unavailable (5xx): stop')
    if r.status_code in (301,302,303,307,308):raise RuntimeError('robots.txt redirects require manual review')
    if r.status_code in (401,403):raise RuntimeError('robots.txt access restricted')
    if r.status_code == 404:return True  # RFC-style absence of rules, not copyright permission
    r.raise_for_status()
    rp=RobotFileParser();rp.parse(r.text.splitlines())
    if not rp.can_fetch(USER_AGENT,path):raise RuntimeError('Disallowed by robots.txt')
    return True


def scan_source(db_path, source_id:int, *, acknowledged=False):
    if not acknowledged:raise PermissionError('Requires explicit provider authorization acknowledgement')
    db=connect(db_path)
    try:
        source=db.execute('SELECT * FROM sources WHERE id=?',(source_id,)).fetchone()
        if not source:raise ValueError('Unknown source')
        if not source['authorized'] or not source['enabled']:
            raise PermissionError('Source must be explicitly authorized and enabled by a privileged ARGUS admin')
        s=requests.Session();s.trust_env=False
        verify_robots(s,source['url'])
        html=get_same_origin(s,source['url'])
        urls=links_from_category(html,source['url'])
        if not urls:raise RuntimeError('Zero listing links; no empty snapshot is accepted as a successful scan')
        # Guard against scraping too much unexpectedly or empty/missing page.
        if len(urls)>100:raise RuntimeError('Page unexpectedly large; manual source review required')
        result=[]
        for index,url in enumerate(urls):
            verify_robots(s,url)
            if index:time.sleep(3.2)
            try:
                page=get_same_origin(s,url)
                parsed=parse_detail(page,url,source['category'])
                result.append(parsed)
            except Exception as e:
                # Fail whole scan rather than infer that a temporarily missing listing was removed.
                raise RuntimeError(f'Scan failed for source record {index + 1}; no changes applied') from e
        return ingest_snapshot(db,source_id,result,complete=True)
    finally:db.close()

if __name__=='__main__':
    p=argparse.ArgumentParser(description='Read-only, consent-gated source polling prototype')
    p.add_argument('--db',required=True);p.add_argument('--source-id',type=int,required=True)
    p.add_argument('--provider-permission-recorded',action='store_true',help='Explicit acknowledgement; must also be enabled in source records by admin')
    args=p.parse_args();print(json.dumps(scan_source(args.db,args.source_id,acknowledged=args.provider_permission_recorded),indent=2))
