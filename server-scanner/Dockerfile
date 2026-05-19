FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --production
COPY scanner.js pending_config.js auth.js ai-agent.js trading_algorithm.md ./
CMD ["node", "scanner.js"]
