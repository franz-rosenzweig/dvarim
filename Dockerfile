# ---- frontend build ----
FROM node:22-alpine AS web
WORKDIR /app
COPY frontend/package*.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ .
# the engine, which the page loads in local mode (vite.config.js: '@engine')
COPY engine/ /engine/
RUN npm run build

# ---- runtime: the server on the engine (server/, docs/DEPLOY.md) ----
# No dependencies to install: the engine and the server use Node's own library.
FROM node:22-alpine
ENV TZ=UTC DVARIM_ROOT=/data DVARIM_STATIC=/app/static NODE_ENV=production
RUN apk add --no-cache tzdata
WORKDIR /app
COPY engine/package.json ./engine/package.json
COPY engine/src ./engine/src
COPY server/package.json ./server/package.json
COPY server/src ./server/src
COPY --from=web /app/dist ./static
VOLUME ["/data"]
EXPOSE 8420
CMD ["node", "server/src/main.js"]
