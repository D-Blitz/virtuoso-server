#!/bin/sh
set -e

# Apply pending migrations, then start.
#
# Doing this in the entrypoint is only safe because this service runs as
# a SINGLE instance — see the scaling note below. With two containers
# booting together, both would race on the migration lock; Prisma
# advisory-locks so one would wait rather than corrupt anything, but the
# loser can time out and crash-loop.
#
# `migrate deploy` applies committed migrations only. It never generates,
# never resets, and never prompts — the one Prisma command that is safe
# to run unattended against production data.
echo "[entrypoint] applying migrations…"
npx prisma migrate deploy

# ── SINGLE INSTANCE, DELIBERATELY ───────────────────────────────────
# src/index.ts starts five setInterval loops in-process: slot-hold sweep,
# enrollment invites, trash purge, reminders, engine resume. Each carries
# a documented single-instance assumption. Running two containers means
# every reminder email goes out twice and every invite cycle runs twice.
#
# So App Runner / ECS must be configured min = max = 1. Scaling out
# requires moving those jobs to a scheduled one-shot task first (e.g.
# EventBridge → a run-once container), not just raising the instance
# count.
echo "[entrypoint] starting API…"
exec node dist/index.js
