"""Staging-only NEXUS Booking rooms service: the live nexus_rooms_http module on a throwaway SQLite, inside the
staging Docker network (and on the host's 127.0.0.1:4176 for the local website). Never the production database."""
import json, os, sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse
sys.path.insert(0, '/rel')
import nexus_rooms_http as R

class H(BaseHTTPRequestHandler):
    def _read_raw_body(self):
        return self.rfile.read(min(int(self.headers.get('Content-Length', '0')), 1024 * 1024))
    def _send_json(self, payload, status=200, headers=None):
        body = json.dumps(payload).encode()
        self.send_response(status); self.send_header('Content-Type', 'application/json'); self.send_header('Content-Length', str(len(body))); self.end_headers(); self.wfile.write(body)
    def do_GET(self):
        p = urlparse(self.path).path
        if p == '/health': return self._send_json({'ok': True})
        if not R.handle(self, 'GET', p): self._send_json({'error': 'NOT_FOUND'}, 404)
    def do_POST(self):
        if not R.handle(self, 'POST', urlparse(self.path).path): self._send_json({'error': 'NOT_FOUND'}, 404)
    def log_message(self, *a): pass

ThreadingHTTPServer(('0.0.0.0', 4176), H).serve_forever()
