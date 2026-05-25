-- Phase 1.1 — admin-initiated cancellation metadata.
--
-- The `status` column already supports 'CANCELED' (set by the webhook
-- on payment_intent.payment_failed for trial events). What's been
-- missing is the WHY + WHEN — needed for the admin UI's cancellation
-- banner ("Annulé le X par Y — raison : Z") and for the audit context
-- of admin-initiated cancels.
--
-- canceledById duplicates audit-log info but inlining it saves a join
-- on the hot path (every event detail view renders the banner if
-- canceledAt != null).

ALTER TABLE "ScheduledEvent" ADD COLUMN "canceledAt"          TIMESTAMP(3);
ALTER TABLE "ScheduledEvent" ADD COLUMN "cancellationReason"  TEXT;
ALTER TABLE "ScheduledEvent" ADD COLUMN "canceledById"        TEXT;
