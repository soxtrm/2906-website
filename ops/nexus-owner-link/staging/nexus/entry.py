"""Start the NEXUS handler of the pinned commit inside the staging network."""
import os
import sys

sys.path.insert(0, "/srv/nexus")
os.chdir("/srv/nexus")

from http.server import ThreadingHTTPServer  # noqa: E402

import nexus_identity  # noqa: E402
from server import Handler  # noqa: E402

if os.getenv("NEXUS_HOUSING_ARGUS_READ_DSN"):
    # The gate requires that NEXUS has no login on the ARGUS database.
    sys.exit("NEXUS_HOUSING_ARGUS_READ_DSN must not be set on staging")

nexus_identity.ensure_identity()
server = ThreadingHTTPServer(("0.0.0.0", 4188), Handler)
print("NEXUS staging listening on 4188, commit", os.getenv("NEXUS_COMMIT"), flush=True)
server.serve_forever()
