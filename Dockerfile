# API image.
#
# Multi-stage so the runtime layer carries only production dependencies
# and compiled JS — no TypeScript, no ts-node, no @faker-js/faker.
#
# Node 22 (not 26): package.json pins a "node" dependency at ^26, but
# that's the `node` npm shim, not the runtime. 22 is the current LTS and
# what Prisma 6 is tested against. Bump deliberately, not by accident.
FROM node:22-slim AS base
# openssl  — Prisma's query engine needs it; slim doesn't ship it.
# The rest  — Chromium's shared libraries, for the Puppeteer instance
#             that renders invoice PDFs (services/invoice/
#             invoicePdfRenderer.ts). Without them Puppeteer installs
#             fine and then fails at launch, so invoices break at the
#             moment someone tries to issue one rather than at deploy.
RUN apt-get update -y && apt-get install -y --no-install-recommends \
      openssl \
      ca-certificates \
      fonts-liberation \
      libasound2 \
      libatk-bridge2.0-0 \
      libatk1.0-0 \
      libcups2 \
      libdbus-1-3 \
      libdrm2 \
      libgbm1 \
      libnspr4 \
      libnss3 \
      libpango-1.0-0 \
      libx11-6 \
      libxcomposite1 \
      libxdamage1 \
      libxext6 \
      libxfixes3 \
      libxkbcommon0 \
      libxrandr2 \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# ── deps ────────────────────────────────────────────────────────────
# Copied separately from the source so a code-only change reuses the
# cached install layer.
FROM base AS deps
COPY package.json package-lock.json* ./
RUN npm ci

# ── build ───────────────────────────────────────────────────────────
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Generate before compiling: the client's generated types are what the
# TypeScript build checks against.
RUN npx prisma generate
RUN npm run build

# ── runtime ─────────────────────────────────────────────────────────
FROM base AS runtime
ENV NODE_ENV=production

# Production dependencies only. Re-generate the Prisma client afterwards
# because `npm ci --omit=dev` wipes node_modules, taking the generated
# client with it.
#
# The `prisma` CLI is a production dependency for this reason: the
# entrypoint runs `prisma migrate deploy`, which would otherwise vanish
# here and leave `npx` trying to fetch it from the network at boot.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev
COPY prisma ./prisma
RUN npx prisma generate

COPY --from=build /app/dist ./dist
# Migrations ship in the image so the container can apply them itself.
COPY --from=build /app/prisma/migrations ./prisma/migrations
COPY docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

# Runs unprivileged. The `node` user ships with the base image.
USER node

EXPOSE 3001
ENTRYPOINT ["./docker-entrypoint.sh"]
