FROM postgres:17-bookworm

RUN apt-get update \
  && apt-get install -y --no-install-recommends nodejs \
  && rm -rf /var/lib/apt/lists/*

COPY deploy/backup.mjs /usr/local/bin/wknowledge-backup.mjs

ENTRYPOINT ["node", "/usr/local/bin/wknowledge-backup.mjs"]
