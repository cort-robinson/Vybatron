FROM node:24-alpine@sha256:44fce696f38ba8c987c4db89954051000bbd05ffd8d8659ba15ed4a8602e937f AS web-build
WORKDIR /build/portal/web
COPY portal/web/package.json portal/web/package-lock.json ./
RUN npm ci
COPY portal/web/ ./
RUN npm run build

FROM node:24-alpine@sha256:44fce696f38ba8c987c4db89954051000bbd05ffd8d8659ba15ed4a8602e937f AS runtime
WORKDIR /app/portal/server
COPY portal/server/package.json portal/server/package-lock.json ./
RUN npm ci --omit=dev
COPY --chown=node:node portal/server/ ./
COPY --chown=node:node --from=web-build /build/portal/web/dist /app/portal/web/dist
RUN mkdir /app/data && chown node:node /app/data
USER node
EXPOSE 3001
CMD ["node", "src/index.js"]
