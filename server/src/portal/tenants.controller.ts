import { Controller, ForbiddenException, Get, NotFoundException, Param, ParseUUIDPipe, Req, UseGuards } from '@nestjs/common';
import { PortalAuthGuard, type PortalRequest } from '../auth/portal-auth.guard.js';
import { isMspRole } from '../auth/roles.js';
import { evaluateLicenses } from '../licensing/license.js';
import { PrismaService } from '../prisma.service.js';
import { agentHealth } from '../reports/reports.service.js';

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

  // Resumo do cabeçalho da empresa no portal: licença e situação dos servidores.
  @Get(':id')
  async summary(@Req() req: PortalRequest, @Param('id', ParseUUIDPipe) id: string) {
    if (!isMspRole(req.user.role) && req.user.tenantId !== id) throw new ForbiddenException('empresa de outro cliente');
    const now = new Date();
    const t = await this.prisma.tenant.findUnique({
      where: { id },
      include: { licenses: true, agents: { where: { disabledAt: null } } },
    });
    if (!t) throw new NotFoundException('empresa não encontrada');
    const s = evaluateLicenses(t.licenses, now);
    const health = t.agents.map((a) => agentHealth(a, now));
    return {
      id: t.id,
      name: t.name,
      license: {
        status: s.status,
        plans: [...new Set(s.licenses.map((l) => l.plan))],
        valid_until: s.validUntil,
        max_agents: s.maxAgents,
        active_agents: t.agents.length,
      },
      agents: {
        ok: health.filter((h) => h === 'ok').length,
        late: health.filter((h) => h === 'late').length,
        stale: health.filter((h) => h === 'stale' || h === 'never').length,
      },
    };
  }
}
