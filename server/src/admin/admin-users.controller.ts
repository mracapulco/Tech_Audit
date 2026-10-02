import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { PortalAuthGuard, type PortalRequest } from '../auth/portal-auth.guard.js';
import { AuditLogService } from '../portal/audit-log.service.js';
import { PrismaService } from '../prisma.service.js';
import { isMspRole, isRole } from '../auth/roles.js';
import { createUser, setUserPassword } from './admin.js';
import { AdminGuard } from './admin.guard.js';
import { asBadRequest, asBody, bool, text } from './input.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Controller('admin/users')
@UseGuards(PortalAuthGuard, AdminGuard)
export class AdminUsersController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
  ) {}

  // Todos os usuários, ou só os de uma empresa (?tenant=).
  @Get()
  async list(@Query('tenant') tenant?: string) {
    if (tenant && !UUID.test(tenant)) throw new BadRequestException('tenant inválido');
    const users = await this.prisma.user.findMany({
      where: tenant ? { tenantId: tenant } : {},
      include: { tenant: { select: { name: true } } },
      orderBy: [{ tenantId: { sort: 'asc', nulls: 'first' } }, { name: 'asc' }],
    });
    return users.map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      role: u.role,
      tenant_id: u.tenantId,
      tenant_name: u.tenant?.name ?? null,
      last_login_at: u.lastLoginAt,
      disabled_at: u.disabledAt,
      created_at: u.createdAt,
    }));
  }

  // Sem senha informada, gera uma e devolve uma única vez.
  @Post()
  async create(@Req() req: PortalRequest, @Body() body: unknown) {
    const b = asBody(body);
    const role = text(b, 'role', 'Perfil', { max: 32 })!;
    const tenantId = text(b, 'tenant_id', 'Empresa', { max: 36, optional: true });
    if (!isRole(role)) throw new BadRequestException('perfil inválido');
    if (isMspRole(role) && tenantId) throw new BadRequestException('administrador da Tech Master não pertence a uma empresa');
    if (!isMspRole(role) && !tenantId) throw new BadRequestException('escolha a empresa do usuário cliente');
    if (tenantId && !UUID.test(tenantId)) throw new BadRequestException('empresa inválida');
    const u = await asBadRequest(() =>
      createUser(this.prisma, {
        email: emailOf(b),
        name: text(b, 'name', 'Nome')!,
        role,
        tenantId,
        password: text(b, 'password', 'Senha', { max: 200, optional: true }),
      }),
    );
    await this.audit.record({ userId: req.user.id, tenantId: u.tenantId, action: 'admin.user.create', ip: req.ip, details: { user: u.id, role: u.role } });
    return u;
  }

  @Patch(':id')
  async update(@Req() req: PortalRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const b = asBody(body);
    const disabled = bool(b, 'disabled');
    if (disabled && id === req.user.id) throw new BadRequestException('você não pode desativar o próprio usuário');
    const u = await asBadRequest(() =>
      this.prisma.$transaction(async (tx) => {
        const user = await tx.user.update({
          where: { id },
          data: {
            name: text(b, 'name', 'Nome', { optional: true }),
            ...(disabled === undefined ? {} : { disabledAt: disabled ? new Date() : null }),
          },
        });
        // Desativar encerra as sessões abertas na hora.
        if (disabled) await tx.userSession.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
        return user;
      }),
    );
    await this.audit.record({
      userId: req.user.id,
      tenantId: u.tenantId,
      action: disabled === undefined ? 'admin.user.update' : disabled ? 'admin.user.disable' : 'admin.user.enable',
      ip: req.ip,
      details: { user: id },
    });
    return { id: u.id, name: u.name, disabled_at: u.disabledAt };
  }

  // Exclui o usuário e as sessões dele. O histórico em portal_audit_log fica,
  // com o id do usuário, para não perder a trilha de auditoria.
  @Delete(':id')
  @HttpCode(204)
  async remove(@Req() req: PortalRequest, @Param('id', ParseUUIDPipe) id: string) {
    if (id === req.user.id) throw new BadRequestException('você não pode excluir o próprio usuário');
    const u = await asBadRequest(() =>
      this.prisma.$transaction(async (tx) => {
        await tx.userSession.deleteMany({ where: { userId: id } });
        return tx.user.delete({ where: { id } });
      }),
    );
    await this.audit.record({
      userId: req.user.id,
      tenantId: u.tenantId,
      action: 'admin.user.delete',
      ip: req.ip,
      details: { user: id, email: u.email },
    });
  }

  @Post(':id/password')
  @HttpCode(200)
  async resetPassword(@Req() req: PortalRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const b = asBody(body);
    const user = await asBadRequest(() => this.prisma.user.findUniqueOrThrow({ where: { id } }));
    const r = await asBadRequest(() => setUserPassword(this.prisma, user.email, text(b, 'password', 'Senha', { max: 200, optional: true })));
    await this.audit.record({ userId: req.user.id, tenantId: user.tenantId, action: 'admin.user.password', ip: req.ip, details: { user: id } });
    return r;
  }
}

function emailOf(b: Record<string, unknown>): string {
  const e = text(b, 'email', 'E-mail')!;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw new BadRequestException('e-mail inválido');
  return e;
}
