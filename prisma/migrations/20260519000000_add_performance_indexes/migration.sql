-- Performance indexes audited in docs/PERF_AUDIT.md
-- All additive; no data mutation; safe to apply on a populated DB.

-- ScheduledEvent: biggest table, zero indexes before this.
CREATE INDEX "ScheduledEvent_organizationId_startTime_idx"
  ON "ScheduledEvent" ("organizationId", "startTime");
CREATE INDEX "ScheduledEvent_status_endTime_idx"
  ON "ScheduledEvent" ("status", "endTime");
CREATE INDEX "ScheduledEvent_locationId_startTime_idx"
  ON "ScheduledEvent" ("locationId", "startTime");
CREATE INDEX "ScheduledEvent_enrollmentId_idx"
  ON "ScheduledEvent" ("enrollmentId");

-- Term: active-term lookup hit on every checkout / cron tick.
CREATE INDEX "Term_locationId_startDate_idx"
  ON "Term" ("locationId", "startDate");
CREATE INDEX "Term_organizationId_startDate_idx"
  ON "Term" ("organizationId", "startDate");

-- Enrollment: active-subscribers list + per-client/per-term lookups.
CREATE INDEX "Enrollment_organizationId_status_idx"
  ON "Enrollment" ("organizationId", "status");
CREATE INDEX "Enrollment_clientId_idx"
  ON "Enrollment" ("clientId");
CREATE INDEX "Enrollment_termId_idx"
  ON "Enrollment" ("termId");

-- Closure: slot-availability scans by location + date window.
CREATE INDEX "Closure_locationId_startDate_idx"
  ON "Closure" ("locationId", "startDate");
CREATE INDEX "Closure_startDate_endDate_idx"
  ON "Closure" ("startDate", "endDate");

-- Facilitator: every facilitator list, recommender.
CREATE INDEX "Facilitator_organizationId_idx"
  ON "Facilitator" ("organizationId");

-- Client: list, search, pickers.
CREATE INDEX "Client_organizationId_idx"
  ON "Client" ("organizationId");

-- Payment: dashboard sorts/filters by createdAt within an org.
CREATE INDEX "Payment_organizationId_createdAt_idx"
  ON "Payment" ("organizationId", "createdAt");
