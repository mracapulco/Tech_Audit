-- AlterTable
ALTER TABLE "agents" ADD COLUMN     "config_applied_version" INTEGER,
ADD COLUMN     "config_fetched_at" TIMESTAMP(3),
ADD COLUMN     "config_version" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "sizes_measured_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "volume_alert_level" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "audited_paths" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "path" TEXT NOT NULL,
    "path_key" TEXT NOT NULL,
    "recursive" BOOLEAN NOT NULL DEFAULT true,
    "audit_read" BOOLEAN NOT NULL DEFAULT false,
    "exclusions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "desired_state" TEXT NOT NULL DEFAULT 'active',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "last_error" TEXT,
    "applied_at" TIMESTAMP(3),
    "size_bytes" BIGINT,
    "size_error" TEXT,
    "size_measured_at" TIMESTAMP(3),
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "audited_paths_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_config_changes" (
    "id" BIGSERIAL NOT NULL,
    "tenant_id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "audited_path_id" UUID,
    "path" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "config_version" INTEGER NOT NULL,
    "user_id" UUID,
    "user_email" TEXT,
    "user_role" TEXT,
    "ip" TEXT,
    "details" JSONB,
    "message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_config_changes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alerts" (
    "id" BIGSERIAL NOT NULL,
    "tenant_id" UUID NOT NULL,
    "agent_id" UUID,
    "kind" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "details" JSONB,
    "acknowledged_at" TIMESTAMP(3),
    "acknowledged_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "alerts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "audited_paths_tenant_id_idx" ON "audited_paths"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "audited_paths_agent_id_path_key_key" ON "audited_paths"("agent_id", "path_key");

-- CreateIndex
CREATE INDEX "audit_config_changes_tenant_id_created_at_idx" ON "audit_config_changes"("tenant_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_config_changes_agent_id_created_at_idx" ON "audit_config_changes"("agent_id", "created_at");

-- CreateIndex
CREATE INDEX "alerts_tenant_id_created_at_idx" ON "alerts"("tenant_id", "created_at");

-- AddForeignKey
ALTER TABLE "audited_paths" ADD CONSTRAINT "audited_paths_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audited_paths" ADD CONSTRAINT "audited_paths_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Log de alterações da auditoria é somente inserção (docs/ARCHITECTURE.md, seção 4.6).
CREATE FUNCTION audit_config_changes_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_config_changes é somente inserção';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_config_changes_no_update
  BEFORE UPDATE OR DELETE ON "audit_config_changes"
  FOR EACH ROW EXECUTE FUNCTION audit_config_changes_immutable();

CREATE TRIGGER audit_config_changes_no_truncate
  BEFORE TRUNCATE ON "audit_config_changes"
  FOR EACH STATEMENT EXECUTE FUNCTION audit_config_changes_immutable();
