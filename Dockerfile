FROM node:24-alpine

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
RUN mkdir -p /data/artifacts && chown -R node:node /app /data
USER node
EXPOSE 3000
VOLUME ["/data"]
CMD ["node", "src/app.js"]
