-- =========================================================================
-- PR 7a: Reschedule support.
--   EnrollmentInvite gets per-invite overrides for the recurring slot.
--   ScheduledEventRescheduleToken: single-use token for trial reschedule
--   (sent in the trial-confirmation email).
-- =========================================================================

ALTER TABLE "EnrollmentInvite" ADD COLUMN "overrideWeekday"   INTEGER;
ALTER TABLE "EnrollmentInvite" ADD COLUMN "overrideStartTime" TEXT;
ALTER TABLE "EnrollmentInvite" ADD COLUMN "rescheduledAt"     TIMESTAMP(3);

CREATE TABLE "ScheduledEventRescheduleToken" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "scheduledEventId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScheduledEventRescheduleToken_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ScheduledEventRescheduleToken_token_key"
    ON "ScheduledEventRescheduleToken"("token");
CREATE INDEX "ScheduledEventRescheduleToken_organizationId_idx"
    ON "ScheduledEventRescheduleToken"("organizationId");
CREATE INDEX "ScheduledEventRescheduleToken_scheduledEventId_idx"
    ON "ScheduledEventRescheduleToken"("scheduledEventId");

ALTER TABLE "ScheduledEventRescheduleToken" ADD CONSTRAINT "ScheduledEventRescheduleToken_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ScheduledEventRescheduleToken" ADD CONSTRAINT "ScheduledEventRescheduleToken_scheduledEventId_fkey"
    FOREIGN KEY ("scheduledEventId") REFERENCES "ScheduledEvent"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
