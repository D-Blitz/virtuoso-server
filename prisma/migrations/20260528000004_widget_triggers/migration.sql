-- CreateTable
CREATE TABLE "WidgetTrigger" (
    "id" TEXT NOT NULL,
    "flowId" TEXT NOT NULL,
    "eventName" TEXT NOT NULL,
    "filter" JSONB,

    CONSTRAINT "WidgetTrigger_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WidgetTrigger_eventName_idx" ON "WidgetTrigger"("eventName");

-- CreateIndex
CREATE UNIQUE INDEX "WidgetTrigger_flowId_eventName_key" ON "WidgetTrigger"("flowId", "eventName");

-- AddForeignKey
ALTER TABLE "WidgetTrigger" ADD CONSTRAINT "WidgetTrigger_flowId_fkey" FOREIGN KEY ("flowId") REFERENCES "WidgetFlow"("id") ON DELETE CASCADE ON UPDATE CASCADE;
