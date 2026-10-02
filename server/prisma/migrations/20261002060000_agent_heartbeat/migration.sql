-- AlterTable
ALTER TABLE "agents" ADD COLUMN     "buffer_bytes" BIGINT,
ADD COLUMN     "buffer_events" INTEGER,
ADD COLUMN     "last_heartbeat_at" TIMESTAMP(3);
