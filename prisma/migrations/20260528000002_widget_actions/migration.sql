-- CreateTable
CREATE TABLE "WidgetAction" (
    "id" TEXT NOT NULL,
    "flowId" TEXT NOT NULL,
    "parentId" TEXT,
    "order" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "config" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "WidgetAction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WidgetAction_flowId_parentId_idx" ON "WidgetAction"("flowId", "parentId");

-- CreateIndex
CREATE INDEX "WidgetAction_flowId_order_idx" ON "WidgetAction"("flowId", "order");

-- AddForeignKey
ALTER TABLE "WidgetAction" ADD CONSTRAINT "WidgetAction_flowId_fkey" FOREIGN KEY ("flowId") REFERENCES "WidgetFlow"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WidgetAction" ADD CONSTRAINT "WidgetAction_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "WidgetAction"("id") ON DELETE CASCADE ON UPDATE CASCADE;
