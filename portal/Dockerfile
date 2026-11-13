FROM node:24.22.2-alpine@sha256:a34ab6d7f6f4813f4d0c5469d74685604b962fbdbf5793a7bc7b4998ecb867c8 AS web-build
WORKDIR /build/portal/web
COPY portal/web/package.json portal/web/package-lock.json ./
RUN npm ci
COPY portal/web/ ./
RUN npm run build

FROM node:24.22.2-alpine@sha256:a34ab6d7f6f4813f4d0c5469d74685604b962fbdbf5793a7bc7b4998ecb867c8 AS runtime
WORKDIR /app/portal/server
COPY portal/server/package.json portal/server/package-lock.json ./
RUN npm ci --omit=dev
COPY --chown=node:node portal/server/ ./
COPY --chown=node:node --from=web-build /build/portal/web/dist /app/portal/web/dist
RUN mkdir /app/data && chown node:node /app/data
USER node
EXPOSE 3001
CMD ["node", "src/index.js"]
