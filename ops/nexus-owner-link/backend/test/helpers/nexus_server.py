"""Start the real NEXUS handler from a NEXUS checkout for the cross-system test.

Usage: python nexus_server.py <nexus repo dir> <port>
Configuration comes from the environment the test sets (local databases only).
"""
import os
import sys

repo, port = sys.argv[1], int(sys.argv[2])
sys.path.insert(0, repo)
os.chdir(repo)

from http.server import ThreadingHTTPServer  # noqa: E402

import nexus_identity  # noqa: E402
from server import Handler  # noqa: E402

nexus_identity.ensure_identity()
server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
print("NEXUS_READY", server.server_port, flush=True)
server.serve_forever()
