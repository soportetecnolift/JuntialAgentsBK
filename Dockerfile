FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup -S app && adduser -S app -G app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
USER app
EXPOSE 4000
HEALTHCHECK CMD wget -qO- http://localhost:4000/healthz || exit 1
CMD ["node", "src/server.js"]
