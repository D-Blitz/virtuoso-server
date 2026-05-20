-- Phase 0.4 — Audit log.
-- See docs/AUDIT_LOG_DESIGN.md.
-- Pure additive table; no data migration.

CREATE TABLE "AuditLogEntry" (
    "id"             TEXT NOT NULL,

    -- Who (denormalized so entries survive user deletion)
    "actorId"        TEXT,
    "actorEmail"     TEXT,
    "actorRole"      TEXT,

    -- What
    "action"         TEXT NOT NULL,   -- CREATE | UPDATE | DELETE
    "entityType"     TEXT NOT NULL,
    "entityId"       TEXT NOT NULL,

    -- State snapshots (JSON scalars; relations not serialized)
    "before"         JSONB,
    "after"          JSONB,

    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    "organizationId" TEXT NOT NULL,

    CONSTRAINT "AuditLogEntry_pkey" PRIMARY KEY ("id")
);

-- Recent activity feed (per-org, time-ordered)
CREATE INDEX "AuditLogEntry_organizationId_createdAt_idx"
  ON "AuditLogEntry" ("organizationId", "createdAt");

-- Per-entity history (e.g. "show every change to ScheduledEvent X")
CREATE INDEX "AuditLogEntry_entityType_entityId_idx"
  ON "AuditLogEntry" ("entityType", "entityId");

-- "What did this user do?" investigation
CREATE INDEX "AuditLogEntry_actorId_idx"
  ON "AuditLogEntry" ("actorId");

ALTER TABLE "AuditLogEntry"
  ADD CONSTRAINT "AuditLogEntry_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
