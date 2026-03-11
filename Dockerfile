# Stage 1: Build React App
FROM node:20-slim AS builder
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

# Stage 2: Serve with Node.js Proxy
FROM node:20-slim
WORKDIR /app
COPY server/package*.json ./server/
RUN cd server && npm install
COPY server/ ./server/
COPY --from=builder /app/dist ./server/public

# Set up Environment
ENV PORT=8080
ENV NODE_ENV=production

EXPOSE 8080
CMD ["node", "server/index.js"]
