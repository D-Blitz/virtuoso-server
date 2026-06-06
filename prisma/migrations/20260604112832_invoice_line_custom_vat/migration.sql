-- AlterTable
ALTER TABLE "InvoiceLine" ADD COLUMN     "vatCents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "vatRate" DOUBLE PRECISION;

-- Backfill per-line VAT for pre-existing lines using their invoice's
-- (single) default rate. New mixed-rate behaviour applies going forward;
-- this just keeps historical lines' vatCents consistent with the invoice
-- total that was already stored.
UPDATE "InvoiceLine" AS il
SET "vatCents" = ROUND(il."amountCents"::numeric * inv."vatRate" / 100.0)::int
FROM "Invoice" AS inv
WHERE il."invoiceId" = inv."id";
