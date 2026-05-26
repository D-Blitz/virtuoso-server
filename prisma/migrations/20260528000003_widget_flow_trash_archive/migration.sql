-- AlterTable
ALTER TABLE "WidgetFlow" ADD COLUMN     "archivedAt" TIMESTAMP(3),
ADD COLUMN     "archivedById" TEXT,
ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "deletedById" TEXT;

-- CreateIndex
CREATE INDEX "WidgetFlow_deletedAt_idx" ON "WidgetFlow"("deletedAt");

-- CreateIndex
CREATE INDEX "WidgetFlow_archivedAt_idx" ON "WidgetFlow"("archivedAt");
