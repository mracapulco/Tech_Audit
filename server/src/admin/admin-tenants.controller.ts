import { BadRequestException, Body, Controller, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { PortalAuthGuard, type PortalRequest } from '../auth/portal-auth.guard.js';
import { evaluateLicenses } from '../licensing/license.js';
import { AuditLogService } from '../portal/audit-log.service.js';
import { PrismaService } from '../prisma.service.js';
import { createEnrollmentToken, createLicense, createTenant, disableAgent } from './admin.js';
import { AdminGuard } from './admin.guard.js';
import { asBadRequest, asBody, day, int, text, volume } from './input.js';

type LicenseRow = Awaited<ReturnType<PrismaService['license']['findMany']>>[number];

// Situação de uma licença isolada, para a tela da empresa.
export function licenseStatus(l: LicenseRow, now = new Date()): 'revoked' | 'scheduled' | 'active' | 'grace' | 'expired' {
  if (l.revokedAt) return 'revoked';
  if (l.validFrom > now) return 'scheduled';
  const s = evaluateLicenses([l], now).status;
  return s === 'none' ? 'expired' : s;
}

const licenseJson = (l: LicenseRow, now: Date) => ({
  id: l.id,
  plan: l.plan,
  max_agents: l.maxAgents,
  max_volume_bytes: l.maxVolumeBytes.toString(),
  retention_days: l.retentionDays,
  valid_from: l.validFrom,
  valid_until: l.validUntil,
  grace_days: l.graceDays,
  revoked_at: l.revokedAt,
  created_at: l.createdAt,
  status: licenseStatus(l, now),
});

@Controller('admin')
@UseGuards(PortalAuthGuard, AdminGuard)
export class AdminTenantsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
  ) {}

  private log(req: PortalRequest, action: string, tenantId: string | null, details: Record<string, string | number | null> = {}) {
    return this.audit.record({ userId: req.user.id, tenantId, action, ip: req.ip, details });
  }

  // Empresas com o resumo de licença, servidores e usuários.
  @Get('tenants')
  async list() {
    const now = new Date();
    const tenants = await this.prisma.tenant.findMany({
      orderBy: { name: 'asc' },
      include: {
        licenses: true,
        _count: { select: { users: { where: { disabledAt: null } }, agents: { where: { disabledAt: null } } } },
      },
    });
    return tenants.map((t) => {
      const s = evaluateLicenses(t.licenses, now);
      return {
        id: t.id,
        name: t.name,
        created_at: t.createdAt,
        license_status: s.status,
        valid_until: s.validUntil,
        max_agents: s.maxAgents,
        max_volume_bytes: s.maxVolumeBytes.toString(),
        active_agents: t._count.agents,
        active_users: t._count.users,
      };
    });
  }

  @Post('tenants')
  async create(@Req() req: PortalRequest, @Body() body: unknown) {
    const name = text(asBody(body), 'name', 'Nome da empresa')!;
    const t = await createTenant(this.prisma, name);
    await this.log(req, 'admin.tenant.create', t.id, { name });
    return { id: t.id, name: t.name };
  }

  @Patch('tenants/:id')
  async rename(@Req() req: PortalRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const name = text(asBody(body), 'name', 'Nome da empresa')!;
    const t = await asBadRequest(() => this.prisma.tenant.update({ where: { id }, data: { name } }));
    await this.log(req, 'admin.tenant.rename', id, { name });
    return { id: t.id, name: t.name };
  }

  @Get('tenants/:id')
  async detail(@Param('id', ParseUUIDPipe) id: string) {
    const now = new Date();
    const t = await this.prisma.tenant.findUnique({
      where: { id },
      include: {
        licenses: { orderBy: { validUntil: 'desc' } },
        agents: { orderBy: [{ disabledAt: { sort: 'asc', nulls: 'first' } }, { hostname: 'asc' }] },
        enrollmentTokens: { orderBy: { createdAt: 'desc' }, take: 50 },
        users: { orderBy: { name: 'asc' } },
      },
    });
    if (!t) throw new NotFoundException('empresa não encontrada');
    const s = evaluateLicenses(t.licenses, now);
    return {
      id: t.id,
      name: t.name,
      created_at: t.createdAt,
      license: {
        status: s.status,
        max_agents: s.maxAgents,
        max_volume_bytes: s.maxVolumeBytes.toString(),
        valid_until: s.validUntil,
        grace_until: s.graceUntil,
        active_agents: t.agents.filter((a) => !a.disabledAt).length,
      },
      licenses: t.licenses.map((l) => licenseJson(l, now)),
      agents: t.agents.map((a) => ({
        id: a.id,
        hostname: a.hostname,
        os: a.os,
        agent_version: a.agentVersion,
        last_seen_at: a.lastSeenAt,
        disabled_at: a.disabledAt,
        created_at: a.createdAt,
      })),
      tokens: t.enrollmentTokens.map((k) => ({
        id: k.id,
        description: k.description,
        expires_at: k.expiresAt,
        max_uses: k.maxUses,
        uses: k.uses,
        revoked_at: k.revokedAt,
        created_at: k.createdAt,
        usable: !k.revokedAt && k.expiresAt > now && k.uses < k.maxUses,
      })),
      users: t.users.map((u) => ({ id: u.id, name: u.name, email: u.email, role: u.role, disabled_at: u.disabledAt })),
    };
  }

  @Post('tenants/:id/licenses')
  async addLicense(@Req() req: PortalRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const b = asBody(body);
    const validFrom = day(b, 'valid_from', 'Início da vigência', false, true) ?? new Date();
    const validUntil = day(b, 'valid_until', 'Fim da vigência', true)!;
    if (validUntil <= validFrom) throw new BadRequestException('o fim da vigência deve ser depois do início');
    const l = await asBadRequest(() =>
      createLicense(this.prisma, {
        tenantId: id,
        plan: text(b, 'plan', 'Plano', { max: 64, optional: true }),
        maxAgents: int(b, 'max_agents', 'Limite de servidores', { min: 1, max: 10_000 })!,
        maxVolumeBytes: volume(b, 'max_volume', 'Volume contratado'),
        retentionDays: int(b, 'retention_days', 'Retenção (dias)', { min: 1, max: 36_500, optional: true }),
        graceDays: int(b, 'grace_days', 'Tolerância (dias)', { min: 0, max: 90, optional: true }),
        validFrom,
        validUntil,
      }),
    );
    await this.log(req, 'admin.license.create', id, { license: l.id, max_agents: l.maxAgents });
    return licenseJson(l, new Date());
  }

  @Post('licenses/:id/revoke')
  @HttpCode(200)
  async revokeLicense(@Req() req: PortalRequest, @Param('id', ParseUUIDPipe) id: string) {
    const l = await asBadRequest(() => this.prisma.license.update({ where: { id }, data: { revokedAt: new Date() } }));
    await this.log(req, 'admin.license.revoke', l.tenantId, { license: id });
    return licenseJson(l, new Date());
  }

  // Token de instalação do agente; o valor aparece uma única vez.
  @Post('tenants/:id/tokens')
  async addToken(@Req() req: PortalRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const b = asBody(body);
    const t = await asBadRequest(() =>
      createEnrollmentToken(this.prisma, {
        tenantId: id,
        ttlHours: int(b, 'ttl_hours', 'Validade (horas)', { min: 1, max: 24 * 30, optional: true }),
        maxUses: int(b, 'max_uses', 'Número de instalações', { min: 1, max: 1000, optional: true }),
        description: text(b, 'description', 'Descrição', { optional: true }),
      }),
    );
    await this.log(req, 'admin.token.create', id, { token: t.id });
    return { id: t.id, token: t.token, expires_at: t.expiresAt, max_uses: t.maxUses };
  }

  @Post('tokens/:id/revoke')
  @HttpCode(200)
  async revokeToken(@Req() req: PortalRequest, @Param('id', ParseUUIDPipe) id: string) {
    const t = await asBadRequest(() => this.prisma.enrollmentToken.update({ where: { id }, data: { revokedAt: new Date() } }));
    await this.log(req, 'admin.token.revoke', t.tenantId, { token: id });
    return { id: t.id, revoked_at: t.revokedAt };
  }

  // Desativar libera a vaga da licença e invalida o token do agente.
  @Post('agents/:id/disable')
  @HttpCode(200)
  async disableAgent(@Req() req: PortalRequest, @Param('id', ParseUUIDPipe) id: string) {
    const a = await asBadRequest(() => disableAgent(this.prisma, id));
    await this.log(req, 'admin.agent.disable', a.tenantId, { agent: id, hostname: a.hostname });
    return { id: a.id, disabled_at: a.disabledAt };
  }
}
