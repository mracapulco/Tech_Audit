import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { PortalRequest } from '../auth/portal-auth.guard.js';

// Telas de administração (empresas, licenças, usuários): só o administrador
// da Tech Master. Usar depois do PortalAuthGuard.
@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<PortalRequest>();
    if (req.user?.role !== 'msp_admin') throw new ForbiddenException('acesso restrito ao administrador');
    return true;
  }
}
