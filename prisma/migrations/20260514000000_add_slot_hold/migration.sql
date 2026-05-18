-- =========================================================================
-- PR 4a: SlotHold table — soft-hold on a candidate booking slot.
-- =========================================================================

CREATE TABLE "SlotHold" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "facilitatorId" TEXT NOT NULL,
    "startTime" TIMESTAMP(3) NOT NULL,
    "endTime" TIMESTAMP(3) NOT NULL,
    "sessionId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SlotHold_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SlotHold_facilitatorId_startTime_idx" ON "SlotHold"("facilitatorId", "startTime");
CREATE INDEX "SlotHold_expiresAt_idx" ON "SlotHold"("expiresAt");
CREATE INDEX "SlotHold_organizationId_idx" ON "SlotHold"("organizationId");

ALTER TABLE "SlotHold" ADD CONSTRAINT "SlotHold_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "SlotHold" ADD CONSTRAINT "SlotHold_facilitatorId_fkey"
    FOREIGN KEY ("facilitatorId") REFERENCES "Facilitator"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
