-- AlterTable
ALTER TABLE "Unavailability" ADD COLUMN     "locationId" TEXT;

-- CreateIndex
CREATE INDEX "Unavailability_locationId_startTime_endTime_idx" ON "Unavailability"("locationId", "startTime", "endTime");

-- AddForeignKey
ALTER TABLE "Unavailability" ADD CONSTRAINT "Unavailability_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE SET NULL ON UPDATE CASCADE;
