-- CreateTable
CREATE TABLE "tenants" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "licenses" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "plan" TEXT NOT NULL,
    "max_agents" INTEGER NOT NULL,
    "max_volume_bytes" BIGINT NOT NULL,
    "retention_days" INTEGER NOT NULL,
    "valid_from" TIMESTAMP(3) NOT NULL,
    "valid_until" TIMESTAMP(3) NOT NULL,
    "grace_days" INTEGER NOT NULL DEFAULT 1,
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "licenses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "enrollment_tokens" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "description" TEXT,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "max_uses" INTEGER NOT NULL,
    "uses" INTEGER NOT NULL DEFAULT 0,
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "enrollment_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agents" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "hostname" TEXT NOT NULL,
    "os" TEXT NOT NULL,
    "machine_id" TEXT NOT NULL,
    "agent_version" TEXT,
    "token_hash" TEXT NOT NULL,
    "last_seen_at" TIMESTAMP(3),
    "disabled_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "license_activations" (
    "id" UUID NOT NULL,
    "license_id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "hostname" TEXT NOT NULL,
    "machine_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "license_activations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ingest_batches" (
    "agent_id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "event_count" INTEGER NOT NULL,
    "inserted_count" INTEGER NOT NULL,
    "rejected_count" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ingest_batches_pkey" PRIMARY KEY ("agent_id","batch_id")
);

-- CreateTable
CREATE TABLE "paths" (
    "id" BIGSERIAL NOT NULL,
    "tenant_id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "path_hash" BYTEA NOT NULL,
    "path" TEXT NOT NULL,

    CONSTRAINT "paths_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identities" (
    "id" BIGSERIAL NOT NULL,
    "tenant_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "sid" TEXT,
    "domain" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "identities_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "licenses_tenant_id_idx" ON "licenses"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "enrollment_tokens_token_hash_key" ON "enrollment_tokens"("token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "agents_token_hash_key" ON "agents"("token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "agents_tenant_id_machine_id_key" ON "agents"("tenant_id", "machine_id");

-- CreateIndex
CREATE INDEX "license_activations_agent_id_idx" ON "license_activations"("agent_id");

-- CreateIndex
CREATE INDEX "paths_tenant_id_idx" ON "paths"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "paths_agent_id_path_hash_key" ON "paths"("agent_id", "path_hash");

-- CreateIndex
CREATE UNIQUE INDEX "identities_tenant_id_key_key" ON "identities"("tenant_id", "key");

-- AddForeignKey
ALTER TABLE "licenses" ADD CONSTRAINT "licenses_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enrollment_tokens" ADD CONSTRAINT "enrollment_tokens_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agents" ADD CONSTRAINT "agents_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "license_activations" ADD CONSTRAINT "license_activations_license_id_fkey" FOREIGN KEY ("license_id") REFERENCES "licenses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "license_activations" ADD CONSTRAINT "license_activations_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
