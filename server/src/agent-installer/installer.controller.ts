import { BadRequestException, Controller, ForbiddenException, Get, NotFoundException, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { createReadStream } from 'node:fs';
import { PortalAuthGuard, type PortalRequest } from '../auth/portal-auth.guard.js';
import { AuditLogService } from '../portal/audit-log.service.js';
import { canDownloadAgent, CONTENT_TYPES, currentInstaller, downloadsDir, PACKAGE_KINDS, type PackageKind } from './installer.js';

const NOT_AVAILABLE = 'instalador do agente indisponível neste servidor';

// Download dos instaladores do agente pelo portal (só com login). Os campos
// de primeiro nível descrevem o MSI do Windows; "linux" traz os pacotes
// .deb e .rpm.
@Controller('agent/installer')
@UseGuards(PortalAuthGuard)
export class InstallerController {
  constructor(private readonly audit: AuditLogService) {}

  @Get()
  async info(@Req() req: PortalRequest) {
    this.check(req);
    const dir = downloadsDir();
    const [win, deb, rpm] = await Promise.all(PACKAGE_KINDS.map((k) => currentInstaller(dir, k)));
    const strip = (i: typeof win) => {
      if (!i) return null;
      const { path: _path, ...info } = i;
      return info;
    };
    return { available: !!win, ...strip(win), linux: { deb: strip(deb), rpm: strip(rpm) } };
  }

  @Get('download')
  async download(@Req() req: PortalRequest, @Res() res: Response, @Query('kind') kindParam?: string) {
    this.check(req);
    const kind = (kindParam ?? 'windows') as PackageKind;
    if (!PACKAGE_KINDS.includes(kind)) throw new BadRequestException('tipo de instalador inválido (windows, deb ou rpm)');
    const i = await currentInstaller(downloadsDir(), kind);
    if (!i) throw new NotFoundException(NOT_AVAILABLE);
    await this.audit.record({
      userId: req.user.id,
      tenantId: req.user.tenantId,
      action: 'agent.download',
      ip: req.ip,
      details: { file: i.file_name, version: i.version, sha256: i.sha256 },
    });
    res.set({
      'content-type': CONTENT_TYPES[kind],
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
