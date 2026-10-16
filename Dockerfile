FROM node:24-alpine@sha256:44fce696f38ba8c987c4db89954051000bbd05ffd8d8659ba15ed4a8602e937f

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY deploy-commands.js ./

RUN mkdir /app/data && chown node:node /app/data
USER node

CMD ["node", "src/index.js"]
