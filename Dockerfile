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
ENV PORT=3050
EXPOSE 3050
CMD ["node", "dist/main"]
