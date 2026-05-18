FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --production
COPY scanner.js pending_config.js ./
CMD ["node", "scanner.js"]
