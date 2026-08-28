# ── Stage 1: Install dependencies & build ─────────────────────────────────
FROM node:24-alpine AS builder

# CI=true prevents pnpm from aborting on no-TTY prompts (e.g. modules-dir purge)
ENV CI=true

RUN corepack enable && corepack prepare pnpm@11.24.0 --activate

WORKDIR /app

# Copy workspace config & package manifests first (better cache)
COPY pnpm-workspace.yaml .npmrc pnpm-lock.yaml ./
COPY package.json ./
COPY web/package.json ./web/

RUN npm config set registry https://registry.npmmirror.com/
RUN pnpm install --frozen-lockfile

# Copy source and build
COPY . .
RUN pnpm build
RUN pnpm --filter llm-gateway-dashboard build

# ── Stage 2: Production ───────────────────────────────────────────────────
FROM node:24-alpine AS production

# tzdata + TZ are NOT required for DB correctness — every MySQL connection's
# session is pinned to UTC in db/index.ts (pool.on('connection') SET SESSION
# time_zone='+00:00'), and formatUtcDateTime uses getUTC* so it's independent
# of the process timezone. Kept only so log/console timestamps read in Beijing
# time (human convenience), not because any time logic depends on it.
RUN apk add --no-cache tzdata
ENV TZ=Asia/Shanghai

RUN corepack enable && corepack prepare pnpm@11.24.0 --activate

WORKDIR /app

# Copy workspace config & package manifests
COPY pnpm-workspace.yaml .npmrc pnpm-lock.yaml ./
COPY package.json ./
COPY web/package.json ./web/

RUN npm config set registry https://registry.npmmirror.com/

# Install production dependencies only
RUN pnpm install --frozen-lockfile --prod && pnpm store prune

# Copy built artifacts + DB migrations (auto-applied on startup)
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/src/db/migrations ./dist/db/migrations
COPY --from=builder /app/web/out ./web/out

# Non-root user
RUN addgroup -g 1001 -S gateway && adduser -S gateway -u 1001
USER gateway

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

CMD ["node", "dist/index.js"]
