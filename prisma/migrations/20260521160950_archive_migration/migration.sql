-- DropForeignKey
ALTER TABLE "EnrollmentInvite" DROP CONSTRAINT "EnrollmentInvite_scheduledEventId_fkey";

-- DropForeignKey
ALTER TABLE "ScheduledEventRescheduleToken" DROP CONSTRAINT "ScheduledEventRescheduleToken_scheduledEventId_fkey";

-- DropForeignKey
ALTER TABLE "SlotHold" DROP CONSTRAINT "SlotHold_facilitatorId_fkey";

-- DropForeignKey
ALTER TABLE "WidgetSubmission" DROP CONSTRAINT "WidgetSubmission_widgetId_fkey";

-- AddForeignKey
ALTER TABLE "SlotHold" ADD CONSTRAINT "SlotHold_facilitatorId_fkey" FOREIGN KEY ("facilitatorId") REFERENCES "Facilitator"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WidgetSubmission" ADD CONSTRAINT "WidgetSubmission_widgetId_fkey" FOREIGN KEY ("widgetId") REFERENCES "BookingWidget"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EnrollmentInvite" ADD CONSTRAINT "EnrollmentInvite_scheduledEventId_fkey" FOREIGN KEY ("scheduledEventId") REFERENCES "ScheduledEvent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduledEventRescheduleToken" ADD CONSTRAINT "ScheduledEventRescheduleToken_scheduledEventId_fkey" FOREIGN KEY ("scheduledEventId") REFERENCES "ScheduledEvent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
