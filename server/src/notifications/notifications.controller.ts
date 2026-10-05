import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { asBody } from '../admin/input.js';
import { PortalAuthGuard, type PortalRequest } from '../auth/portal-auth.guard.js';
import { AuditLogService } from '../portal/audit-log.service.js';
import { NotificationsService } from './notifications.service.js';
import { parseAlertSettings, parseSchedule } from './rules.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const tenantParam = (v: unknown): string | undefined => {
  if (v === undefined || v === '') return undefined;
  if (typeof v !== 'string' || !UUID.test(v)) throw new BadRequestException('empresa inválida');
  return v;
};

// Aba "Alertas e e-mails" do portal. Todos os perfis da empresa consultam;
// administradores (cliente e Tech Master) alteram.
@Controller('notifications')
@UseGuards(PortalAuthGuard)
export class NotificationsController {
  constructor(
    private readonly notifications: NotificationsService,
    private readonly audit: AuditLogService,
  ) {}

  private log(req: PortalRequest, action: string, tenantId: string, details: Record<string, string | number | boolean | string[] | null>) {
    return this.audit.record({ userId: req.user.id, tenantId, action, ip: req.ip, details });
  }

  @Get()
  view(@Req() req: PortalRequest, @Query('tenant') tenant?: string) {
    return this.notifications.view(this.notifications.tenantFor(req.user, tenantParam(tenant)));
  }

  @Post('alerts')
  async saveAlerts(@Req() req: PortalRequest, @Body() body: unknown, @Query('tenant') tenant?: string) {
    this.notifications.assertCanWrite(req.user);
    const tenantId = this.notifications.tenantFor(req.user, tenantParam(tenant));
    const input = parseAlertSettings(asBody(body));
    const r = await this.notifications.saveAlerts(tenantId, req.user, input);
    await this.log(req, 'notifications.alerts.save', tenantId, {
      recipients: input.recipients,
      groups: input.groups,
      mass_delete_threshold: input.massDeleteThreshold,
      mass_delete_window_minutes: input.massDeleteWindowMinutes,
    });
    return r;
  }

  @Post('test')
  @HttpCode(200)
  async test(@Req() req: PortalRequest, @Query('tenant') tenant?: string) {
    this.notifications.assertCanWrite(req.user);
    const tenantId = this.notifications.tenantFor(req.user, tenantParam(tenant));
    const r = await this.notifications.sendTest(tenantId, req.user);
    await this.log(req, 'notifications.test', tenantId, { recipients: r.recipients });
    return r;
  }

  @Post('reports')
  async createReport(@Req() req: PortalRequest, @Body() body: unknown, @Query('tenant') tenant?: string) {
    this.notifications.assertCanWrite(req.user);
    const tenantId = this.notifications.tenantFor(req.user, tenantParam(tenant));
    const r = await this.notifications.createReport(tenantId, req.user, parseSchedule(asBody(body)));
    await this.log(req, 'notifications.report.create', tenantId, { report: r.id, name: r.name, recipients: r.recipients });
    return r;
  }

  @Patch('reports/:id')
  async updateReport(@Req() req: PortalRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    this.notifications.assertCanWrite(req.user);
    const b = asBody(body);
    // Só ligar/pausar, ou a edição completa.
    const keys = Object.keys(b);
    const r =
      keys.length === 1 && keys[0] === 'enabled'
        ? await this.notifications.setEnabled(req.user, id, b.enabled === true)
        : await this.notifications.updateReport(req.user, id, parseSchedule(b));
    await this.log(req, 'notifications.report.update', r.tenant_id, {
      report: id,
      enabled: r.enabled,
      recipients: r.recipients,
    });
    return r;
  }

  @Delete('reports/:id')
  async deleteReport(@Req() req: PortalRequest, @Param('id', ParseUUIDPipe) id: string) {
    this.notifications.assertCanWrite(req.user);
    const r = await this.notifications.deleteReport(req.user, id);
    await this.log(req, 'notifications.report.delete', r.tenantId, { report: id, name: r.name });
    return { ok: true };
  }

  @Post('reports/:id/send')
  @HttpCode(200)
  async sendNow(@Req() req: PortalRequest, @Param('id', ParseUUIDPipe) id: string) {
    this.notifications.assertCanWrite(req.user);
    const r = await this.notifications.sendReportNow(req.user, id);
    await this.log(req, 'notifications.report.send', r.tenant_id, { report: id, recipients: r.recipients });
    return r;
  }
}
