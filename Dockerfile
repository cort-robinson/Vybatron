FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY deploy-commands.js ./

CMD ["node", "src/index.js"]
