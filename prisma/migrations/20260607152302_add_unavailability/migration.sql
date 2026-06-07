-- CreateTable
CREATE TABLE "Unavailability" (
    "id" TEXT NOT NULL,
    "startTime" TIMESTAMP(3) NOT NULL,
    "endTime" TIMESTAMP(3) NOT NULL,
    "reason" TEXT,
    "facilitatorId" TEXT,
    "roomId" TEXT,
    "recurrenceGroupId" TEXT,
    "recurrenceFrequency" TEXT,
    "recurrenceEndDate" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "deletedById" TEXT,
    "organizationId" TEXT NOT NULL,

    CONSTRAINT "Unavailability_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Unavailability_organizationId_startTime_idx" ON "Unavailability"("organizationId", "startTime");

-- CreateIndex
CREATE INDEX "Unavailability_facilitatorId_startTime_endTime_idx" ON "Unavailability"("facilitatorId", "startTime", "endTime");

-- CreateIndex
CREATE INDEX "Unavailability_roomId_startTime_endTime_idx" ON "Unavailability"("roomId", "startTime", "endTime");

-- CreateIndex
CREATE INDEX "Unavailability_recurrenceGroupId_idx" ON "Unavailability"("recurrenceGroupId");

-- CreateIndex
CREATE INDEX "Unavailability_deletedAt_idx" ON "Unavailability"("deletedAt");

-- AddForeignKey
ALTER TABLE "Unavailability" ADD CONSTRAINT "Unavailability_facilitatorId_fkey" FOREIGN KEY ("facilitatorId") REFERENCES "Facilitator"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Unavailability" ADD CONSTRAINT "Unavailability_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Unavailability" ADD CONSTRAINT "Unavailability_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
