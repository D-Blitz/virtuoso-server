-- CreateTable
CREATE TABLE "WidgetRunSubmit" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "stepId" TEXT NOT NULL,
    "clientSubmitId" TEXT NOT NULL,
    "response" JSONB NOT NULL,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WidgetRunSubmit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WidgetRunSubmit_runId_stepId_idx" ON "WidgetRunSubmit"("runId", "stepId");

-- CreateIndex
CREATE UNIQUE INDEX "WidgetRunSubmit_runId_clientSubmitId_key" ON "WidgetRunSubmit"("runId", "clientSubmitId");

-- AddForeignKey
ALTER TABLE "WidgetRunSubmit" ADD CONSTRAINT "WidgetRunSubmit_runId_fkey" FOREIGN KEY ("runId") REFERENCES "WidgetRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
