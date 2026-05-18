-- =========================================================================
-- PR 3a: BookingWidget table. New table only, no backfill needed.
-- =========================================================================

CREATE TABLE "BookingWidget" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "publishableKey" TEXT NOT NULL,
    "allowedOrigins" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "isPublished" BOOLEAN NOT NULL DEFAULT false,
    "serviceIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "locationId" TEXT,
    "draftConfig" JSONB NOT NULL,
    "publishedConfig" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BookingWidget_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BookingWidget_publishableKey_key" ON "BookingWidget"("publishableKey");
CREATE UNIQUE INDEX "BookingWidget_organizationId_slug_key" ON "BookingWidget"("organizationId", "slug");

ALTER TABLE "BookingWidget" ADD CONSTRAINT "BookingWidget_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
