-- =========================================================================
-- PR 6a: Service.bookingMode + EnrollmentInvite + back-refs.
--
-- bookingMode drives whether the trial-then-trimester flow applies.
-- Defaults to LESSON to preserve current behavior for existing services.
-- =========================================================================

ALTER TABLE "Service" ADD COLUMN "bookingMode" TEXT NOT NULL DEFAULT 'LESSON';

CREATE TABLE "EnrollmentInvite" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "scheduledEventId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "sentAt" TIMESTAMP(3),
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EnrollmentInvite_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "EnrollmentInvite_token_key" ON "EnrollmentInvite"("token");
CREATE INDEX "EnrollmentInvite_organizationId_idx" ON "EnrollmentInvite"("organizationId");
CREATE INDEX "EnrollmentInvite_scheduledEventId_idx" ON "EnrollmentInvite"("scheduledEventId");
CREATE INDEX "EnrollmentInvite_expiresAt_idx" ON "EnrollmentInvite"("expiresAt");

ALTER TABLE "EnrollmentInvite" ADD CONSTRAINT "EnrollmentInvite_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "EnrollmentInvite" ADD CONSTRAINT "EnrollmentInvite_scheduledEventId_fkey"
    FOREIGN KEY ("scheduledEventId") REFERENCES "ScheduledEvent"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "EnrollmentInvite" ADD CONSTRAINT "EnrollmentInvite_clientId_fkey"
    FOREIGN KEY ("clientId") REFERENCES "Client"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
