import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Patch,
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
    // Senha certa, mas falta o código do autenticador (ou cadastrá-lo).
    if (result.kind === 'verify') return { mfa: 'verify', challenge: result.challenge, expires_at: result.expiresAt };
    if (result.kind === 'setup') {
      return { mfa: 'setup', challenge: result.challenge, expires_at: result.expiresAt, secret: result.secret, otpauth_url: result.otpauthUrl };
    }
    await this.audit.record({ userId: result.user.id, tenantId: result.user.tenantId, action: 'login', ip: req.ip });
    return { token: result.token, expires_at: result.expiresAt, user: toJson(result.user) };
  }

  // Segunda etapa: o desafio recebido no login e o código de 6 dígitos.
  @Post('login/mfa')
  @HttpCode(200)
  async loginMfa(@Req() req: Request, @Body() body: unknown) {
    const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
    const { challenge, code } = b;
    if (typeof challenge !== 'string' || typeof code !== 'string' || !challenge || !code || challenge.length > 100 || code.length > 20) {
      throw new BadRequestException('informe o código');
    }
    const { userId, outcome } = await this.auth.completeMfa(challenge, code, { ip: req.ip, userAgent: req.headers['user-agent'] });
    if (outcome === 'locked') throw new HttpException('muitos códigos errados; aguarde 15 minutos', HttpStatus.TOO_MANY_REQUESTS);
    if (outcome === 'expired') throw new UnauthorizedException('o tempo para digitar o código acabou; entre de novo');
    if (outcome === 'invalid_code') {
      await this.audit.record({ userId, action: 'login_mfa_failed', ip: req.ip });
      throw new UnauthorizedException('código incorreto');
    }
    await this.audit.record({ userId: outcome.user.id, tenantId: outcome.user.tenantId, action: 'login', ip: req.ip, details: { mfa: true } });
    return { token: outcome.token, expires_at: outcome.expiresAt, user: toJson(outcome.user) };
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

  // --- Minha conta: nome e senha -----------------------------------------

  @Patch('me')
  @UseGuards(PortalAuthGuard)
  async rename(@Req() req: PortalRequest, @Body() body: unknown) {
    const name = (body as Record<string, unknown> | null)?.name;
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 255) throw new BadRequestException('informe o nome (até 255 caracteres)');
    const u = await this.auth.rename(req.user.id, name.trim());
    await this.audit.record({ userId: req.user.id, tenantId: req.user.tenantId, action: 'account.rename', ip: req.ip });
    return toJson(u);
  }

  @Post('password')
  @HttpCode(200)
  @UseGuards(PortalAuthGuard)
  async changePassword(@Req() req: PortalRequest, @Body() body: unknown) {
    const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
    const { current, password } = b;
    if (typeof current !== 'string' || !current) throw new BadRequestException('informe a senha atual');
    if (typeof password !== 'string' || !password || password.length > 200) throw new BadRequestException('informe a nova senha');
    if (!(await this.auth.changePassword(req.user.id, req.user.sessionId, current, password))) throw new BadRequestException('senha atual incorreta');
    await this.audit.record({ userId: req.user.id, tenantId: req.user.tenantId, action: 'account.password', ip: req.ip });
    return { changed: true };
  }

  // --- Minha conta: verificação em duas etapas ---------------------------

  @Get('mfa')
  @UseGuards(PortalAuthGuard)
  mfa(@Req() req: PortalRequest) {
    return this.auth.mfaStatus(req.user.id);
  }

  @Post('mfa/setup')
  @HttpCode(200)
  @UseGuards(PortalAuthGuard)
  mfaSetup(@Req() req: PortalRequest) {
    return this.auth.startMfaSetup(req.user.id);
  }

  @Post('mfa/enable')
  @HttpCode(200)
  @UseGuards(PortalAuthGuard)
  async mfaEnable(@Req() req: PortalRequest, @Body() body: unknown) {
    const code = (body as Record<string, unknown> | null)?.code;
    if (typeof code !== 'string' || !code || code.length > 20) throw new BadRequestException('informe o código');
    if (!(await this.auth.confirmMfaSetup(req.user.id, code))) throw new BadRequestException('código incorreto; confira a hora do celular e tente de novo');
    await this.audit.record({ userId: req.user.id, tenantId: req.user.tenantId, action: 'mfa.enable', ip: req.ip });
    return { enabled: true };
  }

  @Post('mfa/disable')
  @HttpCode(200)
  @UseGuards(PortalAuthGuard)
  async mfaDisable(@Req() req: PortalRequest, @Body() body: unknown) {
    const password = (body as Record<string, unknown> | null)?.password;
    if (typeof password !== 'string' || !password) throw new BadRequestException('informe a senha');
    if (!(await this.auth.disableMfa(req.user.id, password))) throw new BadRequestException('senha incorreta');
    await this.audit.record({ userId: req.user.id, tenantId: req.user.tenantId, action: 'mfa.disable', ip: req.ip });
    return { enabled: false };
  }
}

const toJson = (u: { id: string; tenantId: string | null; email: string; name: string; role: string }) => ({
  id: u.id,
  tenant_id: u.tenantId,
  email: u.email,
  name: u.name,
  role: u.role,
});
