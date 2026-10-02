import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma.service.js';

// Registro de quem consultou ou exportou o quê no portal (seção 8).
@Injectable()
export class AuditLogService {
  private readonly logger = new Logger(AuditLogService.name);

  constructor(private readonly prisma: PrismaService) {}

  async record(entry: {
    userId?: string | null;
    tenantId?: string | null;
    action: string;
    details?: Prisma.InputJsonValue;
    ip?: string | null;
  }): Promise<void> {
    try {
      await this.prisma.portalAuditLog.create({
        data: {
          userId: entry.userId ?? null,
          tenantId: entry.tenantId ?? null,
          action: entry.action,
          details: entry.details,
          ip: entry.ip ?? null,
        },
      });
    } catch (err) {
      // Falha no log não derruba a consulta, mas fica visível nos logs.
      this.logger.error(`portal_audit_log: ${(err as Error).message}`);
    }
  }
}
