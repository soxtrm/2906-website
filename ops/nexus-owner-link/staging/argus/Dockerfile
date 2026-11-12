# ARGUS staging image: the owner-link surface only. Built from an assembled
# directory (see ../build-context.sh): two unmodified production files plus the
# owner-link services and routes of one pinned commit. No .env, no secrets.
FROM node:22-alpine
WORKDIR /srv/argus
RUN npm init -y >/dev/null && npm install --omit=dev --no-audit --no-fund express@^4.18.0 pg@^8.11.0 jsonwebtoken@~9.0.3 express-rate-limit@~7.5.1 >/dev/null
COPY . .
ARG ARGUS_COMMIT=unknown
ENV ARGUS_COMMIT=$ARGUS_COMMIT NODE_ENV=production ARGUS_STAGING=1
USER node
EXPOSE 3001
# Wait for the staging CA so outbound HTTPS to NEXUS staging is verified, never skipped.
CMD ["sh", "-c", "until [ -s \"$NODE_EXTRA_CA_CERTS\" ]; do sleep 1; done; exec node server.js"]
