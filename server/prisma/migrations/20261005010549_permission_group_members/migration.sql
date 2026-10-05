-- CreateTable
CREATE TABLE "permission_group_members" (
    "id" BIGSERIAL NOT NULL,
    "scan_id" UUID NOT NULL,
    "group_name" TEXT NOT NULL,
    "group_sid" TEXT,
    "note" TEXT,
    "error" TEXT,
    "truncated" BOOLEAN NOT NULL DEFAULT false,
    "member_name" TEXT,
    "member_sid" TEXT,
    "member_kind" TEXT,

    CONSTRAINT "permission_group_members_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "permission_group_members_scan_id_idx" ON "permission_group_members"("scan_id");

-- AddForeignKey
ALTER TABLE "permission_group_members" ADD CONSTRAINT "permission_group_members_scan_id_fkey" FOREIGN KEY ("scan_id") REFERENCES "permission_scans"("id") ON DELETE CASCADE ON UPDATE CASCADE;
