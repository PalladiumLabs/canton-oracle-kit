# Copyright 2026 Sats Labs Inc. (d/b/a Palladium Labs)
# SPDX-License-Identifier: Apache-2.0
FROM node:22-slim

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY bin ./bin
COPY src ./src

# State lives on a volume so restarts keep alert and refresh history.
RUN mkdir -p /data && chown node:node /data
ENV STATE_FILE=/data/pusher-state.json
VOLUME ["/data"]

USER node
ENTRYPOINT ["node", "bin/pusher.js"]
CMD ["start"]
