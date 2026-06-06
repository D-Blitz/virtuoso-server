-- DropIndex
DROP INDEX "Invoice_organizationId_number_key";

-- AlterTable
ALTER TABLE "BillingIdentity" ADD COLUMN     "invoicePrefix" TEXT;

-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "issuerId" TEXT;

-- Backfill: point existing invoices at their organization's SCHOOL identity so
-- per-issuer numbering + uniqueness stay coherent for legacy rows.
UPDATE "Invoice" AS inv
SET "issuerId" = bi."id"
FROM "BillingIdentity" AS bi
WHERE bi."organizationId" = inv."organizationId"
  AND bi."ownerType" = 'SCHOOL'
  AND inv."issuerId" IS NULL;

-- CreateIndex
CREATE INDEX "Invoice_issuerId_idx" ON "Invoice"("issuerId");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_organizationId_issuerId_number_key" ON "Invoice"("organizationId", "issuerId", "number");

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_issuerId_fkey" FOREIGN KEY ("issuerId") REFERENCES "BillingIdentity"("id") ON DELETE SET NULL ON UPDATE CASCADE;
