# `mise run update <node-tag>` rewrites the default of NODE_TAG below.
ARG NODE_TAG=26.13.1-bookworm-slim

# Throwaway stage: curl is only needed to fetch rclone, so it stays out of the runtime.
FROM docker.io/library/node:${NODE_TAG} AS rclone
LABEL io.dead-sea-scrolls.build="1"
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates unzip \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /tmp/rclone
RUN curl -fsSL -o rclone.zip https://downloads.rclone.org/v1.75.2/rclone-v1.75.2-linux-amd64.zip \
 && echo "349ac8fba6ff65d6247043f1750cdcb518ec5d500ef91463a10d37c0ccdf3702  rclone.zip" | sha256sum -c - \
 && unzip -q rclone.zip \
 && install -m 0755 rclone-v1.75.2-linux-amd64/rclone /usr/local/bin/rclone

FROM docker.io/library/node:${NODE_TAG} AS build
LABEL io.dead-sea-scrolls.build="1"
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build \
 && npm prune --omit=dev

FROM docker.io/library/node:${NODE_TAG}
LABEL io.dead-sea-scrolls.build="1"
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates unzip \
 && rm -rf /var/lib/apt/lists/*
COPY --from=rclone /usr/local/bin/rclone /usr/local/bin/rclone
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
# git and rclone need a writable home. safe.directory=* is passed as command-line
# config (GIT_CONFIG_PARAMETERS), which git honours even when GIT_CONFIG_GLOBAL=/dev/null.
ENV DSS_BUNDLE_DIR=/bundle \
    DSS_CONFIG_DIR=/config \
    DSS_PORT=32473 \
    NODE_ENV=production \
    HOME=/tmp \
    GIT_CONFIG_PARAMETERS="'safe.directory=*'"
USER node
EXPOSE 32473
CMD ["node","dist/main.js"]
