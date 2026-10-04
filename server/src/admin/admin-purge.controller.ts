import { BadRequestException, Body, Controller, Get, Post, Query, Req, UseGuards } from '@nestjs/common';
import { PortalAuthGuard, type PortalRequest } from '../auth/portal-auth.guard.js';
import { AdminGuard } from './admin.guard.js';
import { asBody } from './input.js';
import { parsePurgeRequest } from './purge.js';
import { PurgeService } from './purge.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Limpeza de eventos: só o administrador da Tech Master.
@Controller('admin/purges')
@UseGuards(PortalAuthGuard, AdminGuard)
export class AdminPurgeController {
  constructor(private readonly purges: PurgeService) {}

  @Get('options')
  options() {
    return this.purges.options();
  }

  // Quantos eventos o pedido apagaria, sem apagar nada.
  @Get('preview')
  preview(@Query() query: Record<string, unknown>) {
    return this.purges.preview(parsePurgeRequest(query));
  }

  @Get()
  list(@Query('tenant_id') tenantId?: string) {
    if (tenantId && !UUID.test(tenantId)) throw new BadRequestException('empresa inválida');
    return this.purges.list(tenantId?.toLowerCase() || null);
  }

  // Responde assim que a limpeza começa; o andamento aparece no histórico.
  @Post()
  start(@Req() req: PortalRequest, @Body() body: unknown) {
    return this.purges.start(parsePurgeRequest(asBody(body)), req.user, req.ip);
  }
}
