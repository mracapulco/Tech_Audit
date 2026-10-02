import { Controller, ForbiddenException, Get, Req, UseGuards } from '@nestjs/common';
import { PortalAuthGuard, type PortalRequest } from '../auth/portal-auth.guard.js';
import { isMspRole } from '../auth/roles.js';
import { PrismaService } from '../prisma.service.js';

@Controller('tenants')
@UseGuards(PortalAuthGuard)
export class TenantsController {
  constructor(private readonly prisma: PrismaService) {}

  // Clientes visíveis para o usuário: todos para a Tech Master, o próprio para o cliente.
  @Get()
  async list(@Req() req: PortalRequest) {
    if (!isMspRole(req.user.role) && !req.user.tenantId) throw new ForbiddenException('usuário sem tenant');
    const where = isMspRole(req.user.role) ? {} : { id: req.user.tenantId! };
    return this.prisma.tenant.findMany({ where, select: { id: true, name: true }, orderBy: { name: 'asc' } });
  }
}
