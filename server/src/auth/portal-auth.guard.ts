import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { bearerToken } from '../common/tokens.js';
import { AuthService } from './auth.service.js';
import type { PortalUser } from './roles.js';

export type PortalRequest = Request & { user: PortalUser };

// Autentica o usuário do portal pelo token de sessão. O portal Next.js guarda
// o token em cookie httpOnly e o repassa no header Authorization.
@Injectable()
export class PortalAuthGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<PortalRequest>();
    const token = bearerToken(req.headers.authorization);
    const user = token ? await this.auth.userForToken(token) : null;
    if (!user) throw new UnauthorizedException('sessão inválida ou expirada');
    req.user = user;
    return true;
  }
}
