import { BadRequestException, Controller, Get, Param, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { PortalAuthGuard, type PortalRequest } from '../auth/portal-auth.guard.js';
import { FilterError, parseFilters, type EventFilters } from '../events/event-query.js';
import { tenantScope } from '../events/events.service.js';
import { AuditLogService } from '../portal/audit-log.service.js';
import { PrismaService } from '../prisma.service.js';
import { reportPdf } from './pdf.js';
import { REPORT_TYPES, ReportsService, type ReportType } from './reports.service.js';
import { reportXlsx } from './xlsx.js';

export const REPORT_FORMATS = ['json', 'xlsx', 'pdf'] as const;
type Format = (typeof REPORT_FORMATS)[number];

// Limite de linhas por formato. A tela mostra uma prévia; o Excel aguenta a
// exportação completa; o PDF é para leitura e impressão.
const EVENTS_MAX = Number(process.env.EXPORT_MAX_ROWS ?? 100_000);
export const REPORT_LIMITS: Record<Format, { grouped: number; events: number }> = {
  json: { grouped: 500, events: 200 },
  xlsx: { grouped: 20_000, events: EVENTS_MAX },
  pdf: { grouped: 5_000, events: 5_000 },
};

const CONTENT_TYPE: Record<Exclude<Format, 'json'>, string> = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pdf: 'application/pdf',
};

@Controller()
@UseGuards(PortalAuthGuard)
export class ReportsController {
  constructor(
    private readonly reports: ReportsService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
  ) {}

  @Get('dashboard')
  async dashboard(@Req() req: PortalRequest, @Query() q: Record<string, unknown>) {
    const f = this.filters(req, q);
    return { tenant: await this.tenant(f), ...(await this.reports.dashboard(f)) };
  }

  @Get('reports/:type')
  async report(@Req() req: PortalRequest, @Param('type') type: string, @Query() q: Record<string, unknown>, @Res({ passthrough: true }) res: Response) {
    if (!(REPORT_TYPES as readonly string[]).includes(type)) throw new BadRequestException(`relatório desconhecido: ${type}`);
    const format = (q.format ?? 'json') as Format;
    if (!(REPORT_FORMATS as readonly string[]).includes(format)) throw new BadRequestException('formato deve ser json, xlsx ou pdf');
    const f = this.filters(req, q);
    const tenant = await this.tenant(f);
    const limits = REPORT_LIMITS[format];
    const t = await this.reports.report(type as ReportType, f, type === 'eventos' ? limits.events : limits.grouped, {
      tenantName: tenant?.name ?? null,
      userName: req.user.name,
    });

    await this.audit.record({
      userId: req.user.id,
      tenantId: tenant?.id ?? null,
      action: format === 'json' ? 'reports.view' : 'reports.export',
      ip: req.ip,
      details: {
        report: type,
        format,
        rows: t.rows.length,
        tenants: f.tenantIds,
        from: f.from.toISOString(),
        to: f.to.toISOString(),
        user: f.user,
        path: f.pathPrefix,
        action: f.action,
      },
    });

    if (format === 'json') return t;
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
    const body = format === 'xlsx' ? reportXlsx(t) : await reportPdf(t);
    res.setHeader('content-type', CONTENT_TYPE[format]);
    res.setHeader('content-disposition', `attachment; filename="relatorio-${type}-${stamp}.${format}"`);
    res.setHeader('cache-control', 'no-store');
    res.send(body);
  }

  private filters(req: PortalRequest, q: Record<string, unknown>): EventFilters {
    try {
      return parseFilters(q, tenantScope(req.user, q.tenant));
    } catch (err) {
      if (err instanceof FilterError) throw new BadRequestException(err.message);
      throw err;
    }
  }

  // Empresa do escopo, quando é uma só (cliente ou Tech Master com filtro).
  private async tenant(f: EventFilters) {
    if (f.tenantIds?.length !== 1) return null;
    return this.prisma.tenant.findUnique({ where: { id: f.tenantIds[0] }, select: { id: true, name: true } });
  }
}
