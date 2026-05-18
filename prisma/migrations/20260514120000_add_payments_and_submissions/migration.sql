-- =========================================================================
-- PR 5a: Payments + Widget submissions + ScheduledEvent lifecycle status.
-- =========================================================================

-- ---------- ScheduledEvent: status + reschedule tracking ----------
ALTER TABLE "ScheduledEvent" ADD COLUMN "status"            TEXT NOT NULL DEFAULT 'SCHEDULED';
ALTER TABLE "ScheduledEvent" ADD COLUMN "rescheduleCount"   INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ScheduledEvent" ADD COLUMN "originalStartTime" TIMESTAMP(3);

-- ---------- WidgetSubmission ----------
CREATE TABLE "WidgetSubmission" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "widgetId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL,
    "ip" TEXT,
    "userAgent" TEXT,
    "acceptedCgvAt" TIMESTAMP(3),
    "cgvVersion" TEXT,
    "resultingScheduledEventId" TEXT,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WidgetSubmission_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "WidgetSubmission_widgetId_idx" ON "WidgetSubmission"("widgetId");
CREATE INDEX "WidgetSubmission_organizationId_idx" ON "WidgetSubmission"("organizationId");

ALTER TABLE "WidgetSubmission" ADD CONSTRAINT "WidgetSubmission_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "WidgetSubmission" ADD CONSTRAINT "WidgetSubmission_widgetId_fkey"
    FOREIGN KEY ("widgetId") REFERENCES "BookingWidget"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "WidgetSubmission" ADD CONSTRAINT "WidgetSubmission_resultingScheduledEventId_fkey"
    FOREIGN KEY ("resultingScheduledEventId") REFERENCES "ScheduledEvent"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------- Payment ----------
CREATE TABLE "Payment" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "stripePaymentIntentId" TEXT NOT NULL,
    "stripeCustomerId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "purpose" TEXT NOT NULL,
    "relatedScheduledEventId" TEXT,
    "relatedEnrollmentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Payment_stripePaymentIntentId_key" ON "Payment"("stripePaymentIntentId");
CREATE INDEX "Payment_organizationId_idx" ON "Payment"("organizationId");
CREATE INDEX "Payment_clientId_idx" ON "Payment"("clientId");

ALTER TABLE "Payment" ADD CONSTRAINT "Payment_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Payment" ADD CONSTRAINT "Payment_clientId_fkey"
    FOREIGN KEY ("clientId") REFERENCES "Client"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Payment" ADD CONSTRAINT "Payment_relatedScheduledEventId_fkey"
    FOREIGN KEY ("relatedScheduledEventId") REFERENCES "ScheduledEvent"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------- StripeEvent (idempotency log) ----------
CREATE TABLE "StripeEvent" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "processedAt" TIMESTAMP(3),
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StripeEvent_pkey" PRIMARY KEY ("id")
);
