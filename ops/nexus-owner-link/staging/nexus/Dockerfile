# NEXUS staging image for the integration gate: the NEXUS server of ONE pinned
# commit (exported into ./src by ../build-context.sh). No secrets in the image.
FROM python:3.11-slim
RUN pip install --no-cache-dir "psycopg[binary]==3.3.8" tzdata >/dev/null
WORKDIR /srv/nexus
COPY src/ /srv/nexus/
COPY entry.py /srv/entry.py
ARG NEXUS_COMMIT=unknown
ENV NEXUS_COMMIT=$NEXUS_COMMIT PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
RUN useradd -r -u 10001 nexus && mkdir -p /data && chown nexus /data
USER nexus
EXPOSE 4188
CMD ["sh", "-c", "until [ -s \"$SSL_CERT_FILE\" ]; do sleep 1; done; exec python /srv/entry.py"]
