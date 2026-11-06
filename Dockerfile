FROM node:24.22.2-alpine@sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY deploy-commands.js ./

RUN mkdir /app/data && chown node:node /app/data
USER node

CMD ["node", "src/index.js"]
