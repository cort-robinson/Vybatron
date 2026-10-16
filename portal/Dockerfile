FROM node:25-alpine@sha256:bdf2cca6fe3dabd014ea60163eca3f0f7015fbd5c7ee1b0e9ccb4ced6eb02ef4 AS web-build
WORKDIR /build/portal/web
COPY portal/web/package.json portal/web/package-lock.json ./
RUN npm ci
COPY portal/web/ ./
RUN npm run build

FROM node:25-alpine@sha256:bdf2cca6fe3dabd014ea60163eca3f0f7015fbd5c7ee1b0e9ccb4ced6eb02ef4 AS runtime
WORKDIR /app/portal/server
COPY portal/server/package.json portal/server/package-lock.json ./
RUN npm ci --omit=dev
COPY --chown=node:node portal/server/ ./
COPY --chown=node:node --from=web-build /build/portal/web/dist /app/portal/web/dist
RUN mkdir /app/data && chown node:node /app/data
USER node
EXPOSE 3001
CMD ["node", "src/index.js"]
