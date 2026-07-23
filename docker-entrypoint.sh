#!/bin/sh
set -e

# A mounted data volume can come up owned by root regardless of the image's
# build-time ownership (this is normal for named Docker volumes), which would
# stop the unprivileged node user from creating /data/artifacts and the SQLite
# database. Make the data directory writable by node, then drop privileges and
# run the given command as node.
mkdir -p "${DATA_DIR:-/data}" "${ARTIFACT_DIR:-/data/artifacts}"
chown -R node:node "${DATA_DIR:-/data}"

exec su-exec node "$@"
