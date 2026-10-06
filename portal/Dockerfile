FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS web-build
WORKDIR /build/portal/web
COPY portal/web/package.json portal/web/package-lock.json ./
RUN npm ci
COPY portal/web/ ./
RUN npm run build

FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS runtime
WORKDIR /app/portal/server
COPY portal/server/package.json portal/server/package-lock.json ./
RUN npm ci --omit=dev
COPY --chown=node:node portal/server/ ./
COPY --chown=node:node --from=web-build /build/portal/web/dist /app/portal/web/dist
RUN mkdir /app/data && chown node:node /app/data
USER node
EXPOSE 3001
CMD ["node", "src/index.js"]
