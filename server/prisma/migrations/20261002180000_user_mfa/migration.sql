-- AlterTable
ALTER TABLE "users" ADD COLUMN     "totp_enabled_at" TIMESTAMP(3),
ADD COLUMN     "totp_last_step" BIGINT,
ADD COLUMN     "totp_pending_secret" TEXT,
ADD COLUMN     "totp_secret" TEXT;

-- CreateTable
CREATE TABLE "login_challenges" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "secret" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "login_challenges_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "login_challenges_token_hash_key" ON "login_challenges"("token_hash");

-- CreateIndex
CREATE INDEX "login_challenges_user_id_idx" ON "login_challenges"("user_id");

-- AddForeignKey
ALTER TABLE "login_challenges" ADD CONSTRAINT "login_challenges_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

