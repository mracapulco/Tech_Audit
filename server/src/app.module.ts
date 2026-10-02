import { Module } from '@nestjs/common';
import { AdminGuard } from './admin/admin.guard.js';
import { AdminTenantsController } from './admin/admin-tenants.controller.js';
import { AdminUsersController } from './admin/admin-users.controller.js';
import { AuthController } from './auth/auth.controller.js';
import { AuthService } from './auth/auth.service.js';
import { PortalAuthGuard } from './auth/portal-auth.guard.js';
import { PgService } from './db/pg.service.js';
import { EnrollmentController } from './enrollment/enrollment.controller.js';
import { EnrollmentService } from './enrollment/enrollment.service.js';
import { EventsController } from './events/events.controller.js';
import { EventsService } from './events/events.service.js';
import { HealthController } from './health.controller.js';
import { AgentAuthGuard } from './ingest/agent-auth.guard.js';
import { IngestController } from './ingest/ingest.controller.js';
import { IngestService } from './ingest/ingest.service.js';
import { LicenseService } from './licensing/license.service.js';
import { AuditLogService } from './portal/audit-log.service.js';
import { TenantsController } from './portal/tenants.controller.js';
import { PrismaService } from './prisma.service.js';

@Module({
  controllers: [
    HealthController,
    EnrollmentController,
    IngestController,
    AuthController,
    TenantsController,
    EventsController,
    AdminTenantsController,
    AdminUsersController,
  ],
  providers: [
    PrismaService,
    PgService,
    LicenseService,
    EnrollmentService,
    IngestService,
    AgentAuthGuard,
    AuthService,
    PortalAuthGuard,
    AuditLogService,
    EventsService,
    AdminGuard,
  ],
})
export class AppModule {}
