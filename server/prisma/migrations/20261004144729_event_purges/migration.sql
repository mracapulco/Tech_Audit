-- CreateTable
CREATE TABLE "event_purges" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "agent_id" UUID,
    "hostname" TEXT,
    "from_time" TIMESTAMP(3),
    "to_time" TIMESTAMP(3) NOT NULL,
    "mode" TEXT NOT NULL,
    "retention_days" INTEGER,
    "user_id" UUID,
    "user_name" TEXT,
    "status" TEXT NOT NULL,
    "expected_count" BIGINT NOT NULL,
    "deleted_count" BIGINT NOT NULL DEFAULT 0,
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "event_purges_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "event_purges_tenant_id_created_at_idx" ON "event_purges"("tenant_id", "created_at");

-- CreateIndex
CREATE INDEX "event_purges_created_at_idx" ON "event_purges"("created_at");

-- AddForeignKey
ALTER TABLE "event_purges" ADD CONSTRAINT "event_purges_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
