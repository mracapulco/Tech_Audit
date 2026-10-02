import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { AuditLogService } from '../portal/audit-log.service.js';
import { AuthService } from './auth.service.js';
import { LoginThrottle } from './login-throttle.js';
import { PortalAuthGuard, type PortalRequest } from './portal-auth.guard.js';

@Controller('auth')
export class AuthController {
  // Por e-mail + IP, e um teto maior só por e-mail: o IP vem de
  // X-Forwarded-For e pode ser trocado a cada tentativa.
  private readonly throttle = new LoginThrottle(5);
  private readonly throttleEmail = new LoginThrottle(20);

  constructor(
    private readonly auth: AuthService,
    private readonly audit: AuditLogService,
  ) {}

  @Post('login')
  @HttpCode(200)
  async login(@Req() req: Request, @Body() body: unknown) {
    const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
    const { email, password } = b;
    if (typeof email !== 'string' || typeof password !== 'string' || !email || !password || email.length > 255) {
      throw new BadRequestException('informe e-mail e senha');
    }
    const emailKey = email.trim().toLowerCase();
    const key = `${emailKey}|${req.ip}`;
    if (this.throttle.blocked(key) || this.throttleEmail.blocked(emailKey)) {
      throw new HttpException('muitas tentativas; aguarde 15 minutos', HttpStatus.TOO_MANY_REQUESTS);
    }
    const result = await this.auth.login(email, password, { ip: req.ip, userAgent: req.headers['user-agent'] });
    if (!result) {
      this.throttle.fail(key);
      this.throttleEmail.fail(emailKey);
      await this.audit.record({ action: 'login_failed', details: { email: email.slice(0, 255) }, ip: req.ip });
      throw new UnauthorizedException('e-mail ou senha incorretos');
    }
    this.throttle.reset(key);
    await this.audit.record({ userId: result.user.id, tenantId: result.user.tenantId, action: 'login', ip: req.ip });
    return { token: result.token, expires_at: result.expiresAt, user: toJson(result.user) };
  }

  @Post('logout')
  @HttpCode(204)
  @UseGuards(PortalAuthGuard)
  async logout(@Req() req: PortalRequest) {
    await this.auth.logout(req.user.sessionId);
    await this.audit.record({ userId: req.user.id, tenantId: req.user.tenantId, action: 'logout', ip: req.ip });
  }

  @Get('me')
  @UseGuards(PortalAuthGuard)
  me(@Req() req: PortalRequest) {
    return toJson(req.user);
  }
}

const toJson = (u: { id: string; tenantId: string | null; email: string; name: string; role: string }) => ({
  id: u.id,
  tenant_id: u.tenantId,
  email: u.email,
  name: u.name,
  role: u.role,
});
