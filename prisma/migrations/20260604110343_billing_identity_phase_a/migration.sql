-- AlterTable
ALTER TABLE "Facilitator" ADD COLUMN     "billingMode" TEXT NOT NULL DEFAULT 'NONE',
ADD COLUMN     "splitRuleMode" TEXT NOT NULL DEFAULT 'MANUAL',
ADD COLUMN     "splitRuleValue" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "BillingIdentity" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "ownerType" TEXT NOT NULL,
    "facilitatorId" TEXT,
    "legalName" TEXT NOT NULL,
    "legalForm" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "addressLine1" TEXT,
    "addressLine2" TEXT,
    "postalCode" TEXT,
    "city" TEXT,
    "country" TEXT DEFAULT 'France',
    "siret" TEXT,
    "vatNumber" TEXT,
    "rcs" TEXT,
    "iban" TEXT,
    "bic" TEXT,
    "logoUrl" TEXT,
    "vatExempt" BOOLEAN NOT NULL DEFAULT false,
    "vatExemptMention" TEXT DEFAULT 'TVA non applicable, art. 293 B du CGI',
    "legalMentions" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BillingIdentity_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BillingIdentity_facilitatorId_key" ON "BillingIdentity"("facilitatorId");

-- CreateIndex
CREATE INDEX "BillingIdentity_organizationId_idx" ON "BillingIdentity"("organizationId");

-- CreateIndex
CREATE INDEX "BillingIdentity_organizationId_ownerType_idx" ON "BillingIdentity"("organizationId", "ownerType");

-- AddForeignKey
ALTER TABLE "BillingIdentity" ADD CONSTRAINT "BillingIdentity_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingIdentity" ADD CONSTRAINT "BillingIdentity_facilitatorId_fkey" FOREIGN KEY ("facilitatorId") REFERENCES "Facilitator"("id") ON DELETE SET NULL ON UPDATE CASCADE;
