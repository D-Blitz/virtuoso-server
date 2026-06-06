-- AlterTable
ALTER TABLE "BillingIdentity" ADD COLUMN     "stripeAccountId" TEXT;

-- CreateTable
CREATE TABLE "FacilitatorPayout" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "facilitatorId" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "method" TEXT NOT NULL,
    "reference" TEXT,
    "note" TEXT,
    "paidAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "stripeTransferId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FacilitatorPayout_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FacilitatorPayout_organizationId_idx" ON "FacilitatorPayout"("organizationId");

-- CreateIndex
CREATE INDEX "FacilitatorPayout_facilitatorId_idx" ON "FacilitatorPayout"("facilitatorId");

-- CreateIndex
CREATE INDEX "FacilitatorPayout_organizationId_facilitatorId_idx" ON "FacilitatorPayout"("organizationId", "facilitatorId");

-- AddForeignKey
ALTER TABLE "FacilitatorPayout" ADD CONSTRAINT "FacilitatorPayout_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FacilitatorPayout" ADD CONSTRAINT "FacilitatorPayout_facilitatorId_fkey" FOREIGN KEY ("facilitatorId") REFERENCES "Facilitator"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
