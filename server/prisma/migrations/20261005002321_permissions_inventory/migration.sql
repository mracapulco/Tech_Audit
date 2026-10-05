-- AlterTable
ALTER TABLE "agents" ADD COLUMN     "permissions_requested_at" TIMESTAMP(3),
ADD COLUMN     "permissions_scanned_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "permission_scans" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "audited_path_id" UUID NOT NULL,
    "path" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "next_part" INTEGER NOT NULL DEFAULT 0,
    "folders_scanned" INTEGER NOT NULL DEFAULT 0,
    "folders_recorded" INTEGER NOT NULL DEFAULT 0,
    "truncated" BOOLEAN NOT NULL DEFAULT false,
    "error" TEXT,
    "started_at" TIMESTAMP(3) NOT NULL,
    "finished_at" TIMESTAMP(3),
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "permission_scans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "permission_entries" (
    "id" BIGSERIAL NOT NULL,
    "scan_id" UUID NOT NULL,
    "folder_path" TEXT NOT NULL,
    "depth" INTEGER NOT NULL,
    "source" TEXT NOT NULL,
    "share" TEXT,
    "owner" TEXT,
    "protected" BOOLEAN NOT NULL DEFAULT false,
    "reason" TEXT NOT NULL,
    "folder_error" TEXT,
    "principal" TEXT,
    "sid" TEXT,
    "kind" TEXT,
    "access" TEXT,
    "rights" TEXT,
    "raw" TEXT,
    "inherited" BOOLEAN NOT NULL DEFAULT false,
    "applies_to" TEXT,

    CONSTRAINT "permission_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "permission_scans_audited_path_id_received_at_idx" ON "permission_scans"("audited_path_id", "received_at");

-- CreateIndex
CREATE INDEX "permission_scans_tenant_id_idx" ON "permission_scans"("tenant_id");

-- CreateIndex
CREATE INDEX "permission_entries_scan_id_idx" ON "permission_entries"("scan_id");

-- AddForeignKey
ALTER TABLE "permission_entries" ADD CONSTRAINT "permission_entries_scan_id_fkey" FOREIGN KEY ("scan_id") REFERENCES "permission_scans"("id") ON DELETE CASCADE ON UPDATE CASCADE;
