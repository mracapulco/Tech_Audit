import { BadRequestException, Controller, Get, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { PortalAuthGuard, type PortalRequest } from '../auth/portal-auth.guard.js';
import { AuditLogService } from '../portal/audit-log.service.js';
import { CSV_BOM, CSV_HEADER, csvLine, eventCsvLine } from './csv.js';
import { decodeCursor, FilterError, parseFilters, parseLimit, type EventFilters } from './event-query.js';
import { EventsService, tenantScope } from './events.service.js';

// Limite da exportação síncrona. Relatórios maiores ficam para o job
// assíncrono no worker (seção 7).
export const EXPORT_MAX_ROWS = Number(process.env.EXPORT_MAX_ROWS ?? 100_000);

@Controller('events')
@UseGuards(PortalAuthGuard)
export class EventsController {
  constructor(
    private readonly events: EventsService,
    private readonly audit: AuditLogService,
  ) {}

  @Get()
  async search(@Req() req: PortalRequest, @Query() q: Record<string, unknown>) {
    const { filters, cursor, limit } = this.parse(req, q, true);
    const page = await this.events.search(filters, cursor, limit);
    // Só a primeira página entra no log; as seguintes são a mesma consulta.
    if (!cursor) await this.log(req, 'events.search', filters);
    return page;
  }

  @Get('export.csv')
  async export(@Req() req: PortalRequest, @Query() q: Record<string, unknown>, @Res() res: Response) {
    const { filters } = this.parse(req, q, false);
    await this.log(req, 'events.export', filters);
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
    res.setHeader('content-type', 'text/csv; charset=utf-8');
    res.setHeader('content-disposition', `attachment; filename="eventos-${stamp}.csv"`);
    res.write(CSV_BOM + csvLine(CSV_HEADER));
    let n = 0;
    try {
      for await (const row of this.events.scan(filters, EXPORT_MAX_ROWS + 1)) {
        if (++n > EXPORT_MAX_ROWS) {
          res.write(csvLine([`# exportação limitada a ${EXPORT_MAX_ROWS} linhas; refine os filtros ou o período`]));
          break;
        }
        if (!res.write(eventCsvLine(row))) await new Promise((r) => res.once('drain', r));
      }
      res.end();
    } catch (err) {
      // Cabeçalhos já enviados: só resta interromper a resposta.
      res.destroy(err as Error);
    }
  }

  private parse(req: PortalRequest, q: Record<string, unknown>, paged: boolean) {
    try {
      const filters = parseFilters(q, tenantScope(req.user, q.tenant));
      return {
        filters,
        cursor: paged ? decodeCursor(q.cursor) : null,
        limit: paged ? parseLimit(q.limit) : 0,
      };
    } catch (err) {
      if (err instanceof FilterError) throw new BadRequestException(err.message);
      throw err;
    }
  }

  private log(req: PortalRequest, action: string, f: EventFilters) {
    return this.audit.record({
      userId: req.user.id,
      tenantId: f.tenantIds?.length === 1 ? f.tenantIds[0] : null,
      action,
      ip: req.ip,
      details: {
        tenants: f.tenantIds,
        from: f.from.toISOString(),
        to: f.to.toISOString(),
        user: f.user,
        path: f.pathPrefix,
        action: f.action,
      },
    });
  }
}
