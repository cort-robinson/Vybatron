FROM node:24.22.3-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5 AS web-build
WORKDIR /build/portal/web
COPY portal/web/package.json portal/web/package-lock.json ./
RUN npm ci
COPY portal/web/ ./
RUN npm run build

FROM node:24.22.3-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5 AS runtime
WORKDIR /app/portal/server
COPY portal/server/package.json portal/server/package-lock.json ./
RUN npm ci --omit=dev
COPY --chown=node:node portal/server/ ./
COPY --chown=node:node --from=web-build /build/portal/web/dist /app/portal/web/dist
RUN mkdir /app/data && chown node:node /app/data
USER node
EXPOSE 3001
CMD ["node", "src/index.js"]
