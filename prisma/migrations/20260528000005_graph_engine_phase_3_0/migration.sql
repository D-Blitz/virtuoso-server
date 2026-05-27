-- AlterTable
ALTER TABLE "WidgetRun" ADD COLUMN     "currentNodeId" TEXT,
ADD COLUMN     "nextResumeAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "WidgetNode" (
    "id" TEXT NOT NULL,
    "flowId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT,
    "config" JSONB NOT NULL DEFAULT '{}',
    "positionX" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "positionY" DOUBLE PRECISION NOT NULL DEFAULT 0,

    CONSTRAINT "WidgetNode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WidgetEdge" (
    "id" TEXT NOT NULL,
    "flowId" TEXT NOT NULL,
    "fromNodeId" TEXT NOT NULL,
    "toNodeId" TEXT NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,
    "condition" JSONB,
    "label" TEXT,

    CONSTRAINT "WidgetEdge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WidgetEntryPoint" (
    "id" TEXT NOT NULL,
    "flowId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "config" JSONB NOT NULL DEFAULT '{}',
    "entryNodeId" TEXT,

    CONSTRAINT "WidgetEntryPoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WidgetResumeToken" (
    "id" TEXT NOT NULL,
    "flowId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumed" BOOLEAN NOT NULL DEFAULT false,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WidgetResumeToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WidgetScheduledResume" (
    "id" TEXT NOT NULL,
    "flowId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "fireAt" TIMESTAMP(3) NOT NULL,
    "consumed" BOOLEAN NOT NULL DEFAULT false,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WidgetScheduledResume_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WidgetNode_flowId_idx" ON "WidgetNode"("flowId");

-- CreateIndex
CREATE INDEX "WidgetNode_flowId_kind_idx" ON "WidgetNode"("flowId", "kind");

-- CreateIndex
CREATE INDEX "WidgetEdge_flowId_idx" ON "WidgetEdge"("flowId");

-- CreateIndex
CREATE INDEX "WidgetEdge_fromNodeId_idx" ON "WidgetEdge"("fromNodeId");

-- CreateIndex
CREATE INDEX "WidgetEdge_toNodeId_idx" ON "WidgetEdge"("toNodeId");

-- CreateIndex
CREATE INDEX "WidgetEntryPoint_flowId_idx" ON "WidgetEntryPoint"("flowId");

-- CreateIndex
CREATE INDEX "WidgetEntryPoint_kind_idx" ON "WidgetEntryPoint"("kind");

-- CreateIndex
CREATE INDEX "WidgetResumeToken_runId_idx" ON "WidgetResumeToken"("runId");

-- CreateIndex
CREATE INDEX "WidgetResumeToken_expiresAt_consumed_idx" ON "WidgetResumeToken"("expiresAt", "consumed");

-- CreateIndex
CREATE INDEX "WidgetScheduledResume_runId_idx" ON "WidgetScheduledResume"("runId");

-- CreateIndex
CREATE INDEX "WidgetScheduledResume_fireAt_consumed_idx" ON "WidgetScheduledResume"("fireAt", "consumed");

-- CreateIndex
CREATE INDEX "WidgetRun_status_nextResumeAt_idx" ON "WidgetRun"("status", "nextResumeAt");

-- AddForeignKey
ALTER TABLE "WidgetNode" ADD CONSTRAINT "WidgetNode_flowId_fkey" FOREIGN KEY ("flowId") REFERENCES "WidgetFlow"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WidgetEdge" ADD CONSTRAINT "WidgetEdge_flowId_fkey" FOREIGN KEY ("flowId") REFERENCES "WidgetFlow"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WidgetEdge" ADD CONSTRAINT "WidgetEdge_fromNodeId_fkey" FOREIGN KEY ("fromNodeId") REFERENCES "WidgetNode"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WidgetEdge" ADD CONSTRAINT "WidgetEdge_toNodeId_fkey" FOREIGN KEY ("toNodeId") REFERENCES "WidgetNode"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WidgetEntryPoint" ADD CONSTRAINT "WidgetEntryPoint_flowId_fkey" FOREIGN KEY ("flowId") REFERENCES "WidgetFlow"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WidgetEntryPoint" ADD CONSTRAINT "WidgetEntryPoint_entryNodeId_fkey" FOREIGN KEY ("entryNodeId") REFERENCES "WidgetNode"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WidgetResumeToken" ADD CONSTRAINT "WidgetResumeToken_flowId_fkey" FOREIGN KEY ("flowId") REFERENCES "WidgetFlow"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WidgetResumeToken" ADD CONSTRAINT "WidgetResumeToken_runId_fkey" FOREIGN KEY ("runId") REFERENCES "WidgetRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WidgetResumeToken" ADD CONSTRAINT "WidgetResumeToken_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "WidgetNode"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WidgetScheduledResume" ADD CONSTRAINT "WidgetScheduledResume_flowId_fkey" FOREIGN KEY ("flowId") REFERENCES "WidgetFlow"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WidgetScheduledResume" ADD CONSTRAINT "WidgetScheduledResume_runId_fkey" FOREIGN KEY ("runId") REFERENCES "WidgetRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WidgetScheduledResume" ADD CONSTRAINT "WidgetScheduledResume_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "WidgetNode"("id") ON DELETE CASCADE ON UPDATE CASCADE;
