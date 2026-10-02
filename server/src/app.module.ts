import { Module } from '@nestjs/common';
import { PgService } from './db/pg.service.js';
import { EnrollmentController } from './enrollment/enrollment.controller.js';
import { EnrollmentService } from './enrollment/enrollment.service.js';
import { HealthController } from './health.controller.js';
import { AgentAuthGuard } from './ingest/agent-auth.guard.js';
import { IngestController } from './ingest/ingest.controller.js';
import { IngestService } from './ingest/ingest.service.js';
import { LicenseService } from './licensing/license.service.js';
import { PrismaService } from './prisma.service.js';

@Module({
  controllers: [HealthController, EnrollmentController, IngestController],
  providers: [PrismaService, PgService, LicenseService, EnrollmentService, IngestService, AgentAuthGuard],
})
export class AppModule {}
