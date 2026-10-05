-- CreateTable
CREATE TABLE "mail_settings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "provider" TEXT NOT NULL,
    "from_address" TEXT NOT NULL,
    "from_name" TEXT NOT NULL DEFAULT 'Tech Audit',
    "portal_url" TEXT,
    "smtp_host" TEXT,
    "smtp_port" INTEGER,
    "smtp_security" TEXT,
    "smtp_user" TEXT,
    "smtp_password" TEXT,
    "ms_tenant_id" TEXT,
    "ms_client_id" TEXT,
    "ms_client_secret" TEXT,
    "updated_by_id" UUID,
    "updated_by_name" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mail_settings_pkey" PRIMARY KEY ("id")
);
