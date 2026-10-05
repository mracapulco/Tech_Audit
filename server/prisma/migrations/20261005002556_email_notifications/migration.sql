-- AlterTable
ALTER TABLE "agents" ADD COLUMN     "offline_alert_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "alerts" ADD COLUMN     "email_attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "emailed_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "notification_settings" (
    "tenant_id" UUID NOT NULL,
    "alert_recipients" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "alert_groups" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "mass_delete_threshold" INTEGER NOT NULL DEFAULT 100,
    "mass_delete_window_minutes" INTEGER NOT NULL DEFAULT 10,
    "updated_by_id" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_settings_pkey" PRIMARY KEY ("tenant_id")
);

-- CreateTable
CREATE TABLE "scheduled_reports" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "report_type" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "frequency" TEXT NOT NULL,
    "weekday" INTEGER,
    "hour" INTEGER NOT NULL,
    "filter_user" TEXT,
    "filter_path" TEXT,
    "filter_action" TEXT,
    "recipients" TEXT[],
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "next_run_at" TIMESTAMP(3) NOT NULL,
    "last_run_at" TIMESTAMP(3),
    "last_status" TEXT,
    "last_error" TEXT,
    "created_by_id" UUID,
    "created_by_name" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "scheduled_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_deliveries" (
    "id" BIGSERIAL NOT NULL,
    "tenant_id" UUID,
    "kind" TEXT NOT NULL,
    "scheduled_report_id" UUID,
    "subject" TEXT NOT NULL,
    "recipients" TEXT[],
    "status" TEXT NOT NULL,
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "scheduled_reports_tenant_id_idx" ON "scheduled_reports"("tenant_id");

-- CreateIndex
CREATE INDEX "scheduled_reports_enabled_next_run_at_idx" ON "scheduled_reports"("enabled", "next_run_at");

-- CreateIndex
CREATE INDEX "email_deliveries_tenant_id_created_at_idx" ON "email_deliveries"("tenant_id", "created_at");

-- CreateIndex
CREATE INDEX "alerts_emailed_at_idx" ON "alerts"("emailed_at");

-- AddForeignKey
ALTER TABLE "notification_settings" ADD CONSTRAINT "notification_settings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scheduled_reports" ADD CONSTRAINT "scheduled_reports_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Alertas anteriores a esta versão não são enviados por e-mail.
UPDATE "alerts" SET "emailed_at" = "created_at" WHERE "emailed_at" IS NULL;
