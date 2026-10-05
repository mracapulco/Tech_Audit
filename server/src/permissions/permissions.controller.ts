import { BadRequestException, Body, Controller, Get, HttpCode, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { asBody } from '../admin/input.js';
import { PortalAuthGuard, type PortalRequest } from '../auth/portal-auth.guard.js';
import { AuditConfigService } from '../auditcfg/audit-config.service.js';
import { AgentAuthGuard, type AgentRequest } from '../ingest/agent-auth.guard.js';
import { AuditLogService } from '../portal/audit-log.service.js';
import { PrismaService } from '../prisma.service.js';
import { reportPdf } from '../reports/pdf.js';
import { reportXlsx } from '../reports/xlsx.js';
import { parsePermissionUpload, PermissionsInputError } from './permissions-input.js';
import { INTERVAL_HOURS, PermissionsService, type PermissionFilters } from './permissions.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const uuidParam = (v: unknown, what: string): string | undefined => {
  if (v === undefined || v === '') return undefined;
  if (typeof v !== 'string' || !UUID.test(v)) throw new BadRequestException(`${what} inválido`);
  return v.toLowerCase();
};

const flag = (v: unknown) => v === '1' || v === 'true' || v === 'on';

// Linhas na tela; o Excel traz tudo até o limite da exportação.
export const SCREEN_ROWS = 1000;
const EXPORT_ROWS: Record<'xlsx' | 'pdf', number> = { xlsx: Number(process.env.EXPORT_MAX_ROWS ?? 100_000), pdf: 5_000 };
const CONTENT_TYPE = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pdf: 'application/pdf',
} as const;

// Lado do agente: recebe a coleta em partes.
@Controller('v1/permissions')
@UseGuards(AgentAuthGuard)
export class AgentPermissionsController {
  constructor(private readonly permissions: PermissionsService) {}

  @Post()
  @HttpCode(200)
  receive(@Req() req: AgentRequest, @Body() body: unknown) {
    let upload;
    try {
      upload = parsePermissionUpload(body);
    } catch (err) {
      if (err instanceof PermissionsInputError) throw new BadRequestException(err.message);
      throw err;
    }
    return this.permissions.receive(req.agent, upload);
  }
}

// Portal: consulta, "Atualizar agora" e exportação. Qualquer perfil da
// empresa consulta (o auditor também); a Tech Master vê todas.
@Controller('permissions')
@UseGuards(PortalAuthGuard)
export class PermissionsController {
  constructor(
    private readonly permissions: PermissionsService,
    private readonly config: AuditConfigService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
  ) {}

  private filters(req: PortalRequest, q: Record<string, unknown>): PermissionFilters {
    const text = typeof q.q === 'string' ? q.q.trim().slice(0, 200) : '';
    return {
      tenantId: this.config.tenantFor(req.user, uuidParam(q.tenant, 'empresa')),
      agentId: uuidParam(q.agent, 'servidor'),
      pathId: uuidParam(q.path, 'caminho'),
      q: text || undefined,
      explicitOnly: flag(q.explicit),
      denyOnly: flag(q.deny),
    };
  }

  private details(f: PermissionFilters) {
    return { agent: f.agentId ?? null, path: f.pathId ?? null, q: f.q ?? null, explicit: !!f.explicitOnly, deny: !!f.denyOnly };
  }

  @Get()
  async view(@Req() req: PortalRequest, @Query() q: Record<string, unknown>) {
    const f = this.filters(req, q);
    if (!(await this.permissions.allowed(f.tenantId))) return { allowed: false, interval_hours: INTERVAL_HOURS, agents: [], rows: [], removed: [], truncated: false };
    const [agents, data] = await Promise.all([this.permissions.status(f.tenantId), this.permissions.rows(f, SCREEN_ROWS)]);
    await this.audit.record({ userId: req.user.id, tenantId: f.tenantId, action: 'permissions.view', ip: req.ip, details: this.details(f) });
    return { allowed: true, interval_hours: INTERVAL_HOURS, agents, ...data };
  }

  @Post('refresh')
  @HttpCode(200)
  async refresh(@Req() req: PortalRequest, @Body() body: unknown) {
    const b = asBody(body);
    const tenantId = this.config.tenantFor(req.user, uuidParam(b.tenant, 'empresa'));
    const agentId = uuidParam(b.agent, 'servidor');
    const r = await this.permissions.refresh(tenantId, agentId);
    await this.audit.record({ userId: req.user.id, tenantId, action: 'permissions.refresh', ip: req.ip, details: { agent: agentId ?? null } });
    return r;
  }

  @Get('export')
  async export(@Req() req: PortalRequest, @Query() q: Record<string, unknown>, @Res({ passthrough: true }) res: Response) {
    const format = q.format;
    if (format !== 'xlsx' && format !== 'pdf') throw new BadRequestException('formato deve ser xlsx ou pdf');
    const f = this.filters(req, q);
    if (!(await this.permissions.allowed(f.tenantId))) throw new BadRequestException('O inventário de permissões faz parte do plano Enterprise.');
    const tenant = await this.prisma.tenant.findUniqueOrThrow({ where: { id: f.tenantId }, select: { name: true } });
    const t = await this.permissions.table(f, EXPORT_ROWS[format], { tenantName: tenant.name, userName: req.user.name });
    await this.audit.record({
      userId: req.user.id,
      tenantId: f.tenantId,
      action: 'permissions.export',
      ip: req.ip,
      details: { ...this.details(f), format, rows: t.rows.length },
    });
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
    const body = format === 'xlsx' ? reportXlsx(t) : await reportPdf(t, `Tech Audit · Inventário de permissões · ${tenant.name}`);
    res.setHeader('content-type', CONTENT_TYPE[format]);
    res.setHeader('content-disposition', `attachment; filename="permissoes-${stamp}.${format}"`);
    res.setHeader('cache-control', 'no-store');
    res.send(body);
  }
}
