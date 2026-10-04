# syntax=docker/dockerfile:1.7

FROM node:22-alpine AS builder
WORKDIR /app
RUN corepack enable && \
    pnpm config set network-concurrency 4 && \
    pnpm config set fetch-retries 5 && \
    pnpm config set fetch-retry-mintimeout 20000 && \
    pnpm config set fetch-retry-maxtimeout 120000
COPY package.json ./
COPY pnpm-lock.yaml* ./
RUN pnpm install --no-frozen-lockfile --ignore-scripts
COPY . .
RUN pnpm build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable && \
    pnpm config set network-concurrency 4 && \
    pnpm config set fetch-retries 5
COPY package.json ./
COPY pnpm-lock.yaml* ./
RUN pnpm install --prod --no-frozen-lockfile --ignore-scripts && pnpm store prune
COPY --from=builder /app/dist ./dist
# The SQL the container applies before the server starts (src/database/migrate.ts).
COPY --from=builder /app/drizzle/*.sql ./drizzle/
ENV PORT=3050
EXPOSE 3050
# Healthy = the server answers, which it only does after its migrations
# applied. With Coolify's health check on, a deploy whose migration fails never
# turns healthy, so the previous container keeps serving. start-period covers
# a slow migration (index builds) before failures start to count.
HEALTHCHECK --interval=10s --timeout=3s --start-period=120s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health" >/dev/null || exit 1
# Migrate first: a failed migration exits non-zero and the new server never
# starts, so code never runs against a schema it doesn't match. `exec` hands
# PID 1 to the server so it receives the stop signal directly.
CMD ["sh", "-c", "node dist/database/migrate && exec node dist/main"]
