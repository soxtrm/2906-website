"""Local-only functional Source Sync demonstration; NO production authentication.

Usage: python prototype/app.py --db /path/demo.sqlite --port 8765
Do not expose publicly; integrate handlers into ARGUS backend auth before deployment.
"""
import argparse, json, mimetypes, os, sys
from pathlib import Path
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlsplit
from source_adapter import CATEGORIES
from store import connect, add_source, ingest_snapshot, decide, stats, list_sources, list_proposals

HERE=Path(__file__).resolve().parent
ROOT=HERE.parent
HTML=(HERE/"dashboard.html").read_text(encoding="utf-8") if (HERE/"dashboard.html").exists() else "<h1>Dashboard missing</h1>"


def demo_fixture():
    return json.loads((ROOT/"fixtures"/"observed_2026-11-09.json").read_text(encoding="utf-8"))

class Handler(BaseHTTPRequestHandler):
    def json_out(self,obj,code=200):
        body=json.dumps(obj,ensure_ascii=False,default=str).encode()
        self.send_response(code)
        self.send_header("Content-Type","application/json; charset=utf-8")
        self.send_header("Cache-Control","no-store")
        self.send_header("Content-Length",str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def get_db(self):
        return connect(self.server.db_path)
    def do_GET(self):
        route=urlsplit(self.path).path
        if route == '/':
            body=HTML.encode()
            self.send_response(200);self.send_header('Content-Type','text/html; charset=utf-8');self.send_header('Cache-Control','no-store');self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
        elif route.startswith('/api/'):
            db=self.get_db()
            try:
                if route=='/api/status':
                    self.json_out({'mode':'LOCAL_PROTOTYPE_NOT_ARGUS_PRODUCTION','stats':stats(db),'sources':list_sources(db)})
                elif route=='/api/proposals':
                    self.json_out({'items':list_proposals(db)})
                elif route=='/api/approved':
                    rows=[dict(x) for x in db.execute('SELECT source_id,external_id,updated_at,canonical_property_id FROM approved_imports ORDER BY updated_at DESC')]
                    self.json_out({'items':rows})
                else:
                    self.json_out({'error':'Not found'},404)
            finally:db.close()
        else:
            self.json_out({'error':'Not found'},404)
    def do_POST(self):
        path=urlsplit(self.path).path
        try:
            length=int(self.headers.get('Content-Length', '0'))
            if length>1_000_000: raise ValueError('Payload exceeds local limit')
            data=json.loads(self.rfile.read(length)) if length else {}
            db=self.get_db()
            try:
                if path=='/api/add-source':
                    sid=add_source(db,data.get('name','My Next Home'),data['url'],data['category'])
                    self.json_out({'source_id':sid,'message':'Source registered but live polling disabled pending permission & ARGUS integration'})
                elif path=='/api/demo-scan':
                    source_id=int(data['source_id'])
                    src=db.execute('SELECT * FROM sources WHERE id=?',(source_id,)).fetchone()
                    if not src:raise ValueError('Source not found')
                    fixture=demo_fixture()
                    entries=[i for i in fixture['listings'] if i['category']==src['category']]
                    self.json_out({'scan':ingest_snapshot(db,source_id,entries,True),'note':'Offline demo snapshot. NOT live website sync.'})
                elif path.startswith('/api/proposals/') and path.endswith('/decision'):
                    pid=int(path.split('/')[3])
                    decide(db,pid,data['decision'],reviewer='local-dashboard-demo')
                    self.json_out({'ok':True,'note':'Approved only into LOCAL staging; ARGUS canonical inventory unchanged.'})
                else:self.json_out({'error':'Unknown endpoint'},404)
            finally:db.close()
        except Exception as e:
            self.json_out({'error':str(e)},400)
    def log_message(self,fmt,*args):
        sys.stderr.write('[SourceSync local] '+fmt%args+'\n')


def main():
    p=argparse.ArgumentParser()
    p.add_argument('--db',default=str(HERE/'source-sync-demo.sqlite'))
    p.add_argument('--port',type=int,default=8765)
    args=p.parse_args()
    connect(args.db).close()
    httpd=ThreadingHTTPServer(('127.0.0.1',args.port),Handler)
    httpd.db_path=args.db
    print(f'LOCAL DEMO ONLY: http://127.0.0.1:{args.port}/')
    print('No network polling and no production API; manual fixture scan only')
    try:httpd.serve_forever()
    except KeyboardInterrupt: pass
if __name__=='__main__':main()
