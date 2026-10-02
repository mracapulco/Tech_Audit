import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { PortalAuthGuard, type PortalRequest } from '../auth/portal-auth.guard.js';
import { asBody, bool } from '../admin/input.js';
import { AuditLogService } from '../portal/audit-log.service.js';
import { AuditConfigService, type PathOptions } from './audit-config.service.js';
import { normalizePath, parseExclusions, PathError } from './paths.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const uuidParam = (v: unknown, what: string): string | undefined => {
  if (v === undefined || v === '') return undefined;
  if (typeof v !== 'string' || !UUID.test(v)) throw new BadRequestException(`${what} inválido`);
  return v;
};

// O portal mostra o aviso de que o agente vai alterar a SACL e a política de
// auditoria; a API exige a confirmação explícita no corpo.
function requireConfirm(b: Record<string, unknown>) {
  if (b.confirm !== true) throw new BadRequestException('confirme que o agente vai alterar a política de auditoria e a SACL do caminho');
}

function options(b: Record<string, unknown>, current?: PathOptions): PathOptions {
  try {
    return {
      recursive: bool(b, 'recursive') ?? current?.recursive ?? true,
      auditRead: bool(b, 'audit_read') ?? current?.auditRead ?? false,
      exclusions: b.exclusions === undefined && current ? current.exclusions : parseExclusions(b.exclusions),
    };
  } catch (err) {
    if (err instanceof PathError) throw new BadRequestException(err.message);
    throw err;
  }
}

// Caminhos auditados no portal (seção 4.6). Cliente e Tech Master alteram;
// o auditor do cliente só consulta.
@Controller('config')
@UseGuards(PortalAuthGuard)
export class ConfigController {
  constructor(
    private readonly config: AuditConfigService,
    private readonly audit: AuditLogService,
  ) {}

  private log(req: PortalRequest, action: string, tenantId: string, details: Record<string, string | boolean | null>) {
    return this.audit.record({ userId: req.user.id, tenantId, action, ip: req.ip, details });
  }

  private requester(req: PortalRequest) {
    return { user: req.user, ip: req.ip ?? null };
  }

  @Get()
  async view(@Req() req: PortalRequest, @Query('tenant') tenant?: string) {
    return this.config.view(this.config.tenantFor(req.user, uuidParam(tenant, 'empresa')));
  }

  @Get('changes')
  async changes(
    @Req() req: PortalRequest,
    @Query('tenant') tenant?: string,
    @Query('agent') agent?: string,
    @Query('before') before?: string,
    @Query('limit') limit?: string,
  ) {
    const tenantId = this.config.tenantFor(req.user, uuidParam(tenant, 'empresa'));
    if (before !== undefined && before !== '' && !/^\d{1,18}$/.test(before)) throw new BadRequestException('before inválido');
    const n = limit ? Number(limit) : 50;
    if (!Number.isInteger(n) || n < 1 || n > 500) throw new BadRequestException('limit deve ser de 1 a 500');
    const page = await this.config.changes(tenantId, { agentId: uuidParam(agent, 'servidor'), before: before ? BigInt(before) : undefined, limit: n });
    if (!before) await this.log(req, 'config.changes', tenantId, { agent: agent ?? null });
    return page;
  }

  @Post('agents/:agentId/paths')
  async add(@Req() req: PortalRequest, @Param('agentId', ParseUUIDPipe) agentId: string, @Body() body: unknown) {
    const b = asBody(body);
    requireConfirm(b);
    let path: string;
    try {
      path = normalizePath(b.path);
    } catch (err) {
      if (err instanceof PathError) throw new BadRequestException(err.message);
      throw err;
    }
    const p = await this.config.addPath(this.requester(req), agentId, path, options(b), bool(b, 'override_volume') === true);
    await this.log(req, 'config.path.add', p.tenant_id, { path: p.path, agent: agentId });
    return p;
  }

  @Patch('paths/:id')
  async update(@Req() req: PortalRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const b = asBody(body);
    requireConfirm(b);
    const p = await this.config.updatePath(this.requester(req), id, (current) => options(b, current));
    await this.log(req, 'config.path.update', p.tenant_id, { path: p.path });
    return p;
  }

  @Delete('paths/:id')
  @HttpCode(200)
  async remove(@Req() req: PortalRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    requireConfirm(asBody(body));
    const p = await this.config.removePath(this.requester(req), id);
    await this.log(req, 'config.path.remove', p.tenant_id, { path: p.path });
    return p;
  }

  @Post('paths/:id/reapply')
  @HttpCode(200)
  async reapply(@Req() req: PortalRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    requireConfirm(asBody(body));
    const p = await this.config.reapply(this.requester(req), id);
    await this.log(req, 'config.path.reapply', p.tenant_id, { path: p.path });
    return p;
  }

  @Post('alerts/:id/ack')
  @HttpCode(200)
  async ack(@Req() req: PortalRequest, @Param('id') id: string) {
    if (!/^\d{1,18}$/.test(id)) throw new BadRequestException('alerta inválido');
    return this.config.ackAlert(req.user, BigInt(id));
  }
}
