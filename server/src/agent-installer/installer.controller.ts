import { Controller, ForbiddenException, Get, NotFoundException, Req, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { createReadStream } from 'node:fs';
import { PortalAuthGuard, type PortalRequest } from '../auth/portal-auth.guard.js';
import { AuditLogService } from '../portal/audit-log.service.js';
import { canDownloadAgent, currentInstaller } from './installer.js';

const NOT_AVAILABLE = 'instalador do agente indisponível neste servidor';

// Download do instalador do agente pelo portal (só com login).
@Controller('agent/installer')
@UseGuards(PortalAuthGuard)
export class InstallerController {
  constructor(private readonly audit: AuditLogService) {}

  @Get()
  async info(@Req() req: PortalRequest) {
    this.check(req);
    const i = await currentInstaller();
    if (!i) return { available: false };
    const { path: _path, ...info } = i;
    return { available: true, ...info };
  }

  @Get('download')
  async download(@Req() req: PortalRequest, @Res() res: Response) {
    this.check(req);
    const i = await currentInstaller();
    if (!i) throw new NotFoundException(NOT_AVAILABLE);
    await this.audit.record({
      userId: req.user.id,
      tenantId: req.user.tenantId,
      action: 'agent.download',
      ip: req.ip,
      details: { file: i.file_name, version: i.version, sha256: i.sha256 },
    });
    res.set({
      'content-type': 'application/x-msi',
      'content-length': String(i.size),
      'content-disposition': `attachment; filename="${i.file_name}"`,
      'cache-control': 'no-store',
    });
    createReadStream(i.path)
      .on('error', () => res.destroy())
      .pipe(res);
  }

  private check(req: PortalRequest) {
    if (!canDownloadAgent(req.user.role)) throw new ForbiddenException('seu perfil não pode baixar o agente');
  }
}
