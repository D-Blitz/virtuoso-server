-- Phase 2.0 — Commit 1 of 5: workflow engine storage layer.
--
-- Lands the shape needed to MODEL a flow + RUN a flow + METER actions.
-- Explicitly NOT in this commit (each ships in its own commit later):
--   • WidgetAction / WidgetActionKind  → 2.0 Commit 2 (action engine + runtime)
--   • WidgetTrigger / TriggerEventName → 2.0 Commit 2 (bus wiring)
--   • WidgetCron                       → 2.4 (time-based triggers)
--   • WidgetEmailTemplate              → 2.3 (email migration)
--   • CustomFieldDefinition + JSONB    → 2.5a (custom fields)
--
-- This commit is intentionally SQL-only. No backfill, no seed flows —
-- those land with Commit 5 (demo flow + smoke test).
--
-- See artcetera_admin/docs/WORKFLOW_ENGINE_DESIGN.md §5 for the model
-- rationale and §15 for the five-commit Phase 2.0 plan.

-- CreateEnum
CREATE TYPE "WidgetFlowKind" AS ENUM ('BOOKING', 'EVENT_REACTION');

-- CreateEnum
CREATE TYPE "WidgetStepKind" AS ENUM ('SINGLE_SELECT', 'MULTI_SELECT', 'RADIO', 'CHECKBOX', 'TEXT_INPUT', 'TEXTAREA', 'NUMBER', 'EMAIL', 'PHONE', 'DATE_PICKER', 'TIME_PICKER', 'SLOT_PICKER', 'FORM', 'TEXT_BLOCK', 'RECAP', 'STRIPE_CHECKOUT', 'VALIDATION');

-- CreateEnum
CREATE TYPE "WidgetFieldKind" AS ENUM ('TEXT', 'TEXTAREA', 'EMAIL', 'PHONE', 'NUMBER', 'DATE', 'BOOLEAN', 'SELECT', 'MULTI_SELECT');

-- CreateEnum
CREATE TYPE "WidgetFieldBinding" AS ENUM ('VAR', 'DB_COLUMN', 'CUSTOM_FIELD');

-- CreateTable
CREATE TABLE "WidgetFlow" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "kind" "WidgetFlowKind" NOT NULL DEFAULT 'BOOKING',
    "isTemplate" BOOLEAN NOT NULL DEFAULT false,
    "isPublished" BOOLEAN NOT NULL DEFAULT false,
    "publishableKey" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WidgetFlow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WidgetStep" (
    "id" TEXT NOT NULL,
    "flowId" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "kind" "WidgetStepKind" NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT,
    "config" JSONB NOT NULL DEFAULT '{}',
    "visibleWhen" JSONB,

    CONSTRAINT "WidgetStep_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WidgetField" (
    "id" TEXT NOT NULL,
    "stepId" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "kind" "WidgetFieldKind" NOT NULL,
    "label" TEXT NOT NULL,
    "placeholder" TEXT,
    "required" BOOLEAN NOT NULL DEFAULT false,
    "binding" "WidgetFieldBinding" NOT NULL,
    "bindingTarget" TEXT NOT NULL,
    "config" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "WidgetField_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WidgetRun" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "flowId" TEXT NOT NULL,
    "vars" JSONB NOT NULL DEFAULT '{}',
    "currentStepId" TEXT,
    "status" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "stepHistory" JSONB NOT NULL DEFAULT '[]',

    CONSTRAINT "WidgetRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WidgetFlowDraft" (
    "id" TEXT NOT NULL,
    "flowId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WidgetFlowDraft_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WidgetFlowSnapshot" (
    "id" TEXT NOT NULL,
    "flowId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WidgetFlowSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EngineActionEvent" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "flowId" TEXT,
    "runId" TEXT,
    "actionKind" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "errorMessage" TEXT,
    "executedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EngineActionEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WidgetFlow_publishableKey_key" ON "WidgetFlow"("publishableKey");

-- CreateIndex
CREATE INDEX "WidgetFlow_organizationId_idx" ON "WidgetFlow"("organizationId");

-- CreateIndex
CREATE INDEX "WidgetFlow_organizationId_isPublished_idx" ON "WidgetFlow"("organizationId", "isPublished");

-- CreateIndex
CREATE INDEX "WidgetStep_flowId_idx" ON "WidgetStep"("flowId");

-- CreateIndex
CREATE UNIQUE INDEX "WidgetStep_flowId_order_key" ON "WidgetStep"("flowId", "order");

-- CreateIndex
CREATE INDEX "WidgetField_stepId_idx" ON "WidgetField"("stepId");

-- CreateIndex
CREATE UNIQUE INDEX "WidgetField_stepId_order_key" ON "WidgetField"("stepId", "order");

-- CreateIndex
CREATE INDEX "WidgetRun_organizationId_startedAt_idx" ON "WidgetRun"("organizationId", "startedAt");

-- CreateIndex
CREATE INDEX "WidgetRun_flowId_status_idx" ON "WidgetRun"("flowId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "WidgetFlowDraft_flowId_key" ON "WidgetFlowDraft"("flowId");

-- CreateIndex
CREATE INDEX "WidgetFlowSnapshot_flowId_idx" ON "WidgetFlowSnapshot"("flowId");

-- CreateIndex
CREATE UNIQUE INDEX "WidgetFlowSnapshot_flowId_version_key" ON "WidgetFlowSnapshot"("flowId", "version");

-- CreateIndex
CREATE INDEX "EngineActionEvent_organizationId_executedAt_idx" ON "EngineActionEvent"("organizationId", "executedAt");

-- CreateIndex
CREATE INDEX "EngineActionEvent_organizationId_actionKind_executedAt_idx" ON "EngineActionEvent"("organizationId", "actionKind", "executedAt");

-- AddForeignKey
ALTER TABLE "WidgetFlow" ADD CONSTRAINT "WidgetFlow_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WidgetStep" ADD CONSTRAINT "WidgetStep_flowId_fkey" FOREIGN KEY ("flowId") REFERENCES "WidgetFlow"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WidgetField" ADD CONSTRAINT "WidgetField_stepId_fkey" FOREIGN KEY ("stepId") REFERENCES "WidgetStep"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WidgetRun" ADD CONSTRAINT "WidgetRun_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WidgetRun" ADD CONSTRAINT "WidgetRun_flowId_fkey" FOREIGN KEY ("flowId") REFERENCES "WidgetFlow"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WidgetFlowDraft" ADD CONSTRAINT "WidgetFlowDraft_flowId_fkey" FOREIGN KEY ("flowId") REFERENCES "WidgetFlow"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WidgetFlowSnapshot" ADD CONSTRAINT "WidgetFlowSnapshot_flowId_fkey" FOREIGN KEY ("flowId") REFERENCES "WidgetFlow"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EngineActionEvent" ADD CONSTRAINT "EngineActionEvent_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
