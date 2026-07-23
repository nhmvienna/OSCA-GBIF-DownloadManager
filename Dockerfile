FROM node:24-alpine

# su-exec lets the entrypoint fix the data-volume ownership as root and then
# drop privileges to the unprivileged node user.
RUN apk add --no-cache su-exec

ENV NODE_ENV=production \
    DATA_DIR=/data \
    DATABASE_PATH=/data/manager.sqlite \
    ARTIFACT_DIR=/data/artifacts \
    HOST=0.0.0.0 \
    PORT=3000

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh \
    && mkdir -p /data/artifacts \
    && chown -R node:node /app /data
EXPOSE 3000
VOLUME ["/data"]

# Runs as root only to normalize the mounted volume's ownership, then the
# entrypoint execs the app as the node user via su-exec.
ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "src/app.js"]
