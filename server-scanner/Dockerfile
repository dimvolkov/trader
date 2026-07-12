FROM node:20-alpine AS builder
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package.json ./
RUN npm install --production

FROM node:20-alpine
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY scanner.js pending_config.js auth.js ai-agent.js candle_store.js langfuse.js trading_algorithm.md package.json ./
CMD ["node", "scanner.js"]
