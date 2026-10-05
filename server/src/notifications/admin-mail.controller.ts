import { BadRequestException, Body, Controller, Get, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import { AdminGuard } from '../admin/admin.guard.js';
import { asBody } from '../admin/input.js';
import { PortalAuthGuard, type PortalRequest } from '../auth/portal-auth.guard.js';
import { AuditLogService } from '../portal/audit-log.service.js';
import { PrismaService } from '../prisma.service.js';
import { parseMailSettings } from './mail-settings.js';
import { MailerService } from './mailer.service.js';
import { parseRecipients } from './rules.js';
import { encryptSecret, secretsKeyOk } from './secrets.js';
import { serverTestMail } from './templates.js';

// Tela "Servidor de e-mail": só o administrador da Tech Master. Senha e
// segredo nunca voltam para o portal; só se há um salvo.
@Controller('admin/mail')
@UseGuards(PortalAuthGuard, AdminGuard)
export class AdminMailController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mailer: MailerService,
    private readonly audit: AuditLogService,
  ) {}

  @Get()
  async view() {
    const s = await this.prisma.mailSettings.findUnique({ where: { id: 1 } });
    return {
      configured: s !== null,
      secrets_key_ok: secretsKeyOk(),
      provider: s?.provider ?? 'microsoft365',
      from_address: s?.fromAddress ?? '',
      from_name: s?.fromName ?? 'Tech Audit',
      portal_url: s?.portalUrl ?? '',
      smtp_host: s?.smtpHost ?? '',
      smtp_port: s?.smtpPort ?? 587,
      smtp_security: s?.smtpSecurity ?? 'starttls',
      smtp_user: s?.smtpUser ?? '',
      has_smtp_password: !!s?.smtpPassword,
      ms_tenant_id: s?.msTenantId ?? '',
      ms_client_id: s?.msClientId ?? '',
      has_ms_client_secret: !!s?.msClientSecret,
      updated_at: s?.updatedAt ?? null,
      updated_by_name: s?.updatedByName ?? null,
    };
  }

  @Post()
  @HttpCode(200)
  async save(@Req() req: PortalRequest, @Body() body: unknown) {
    if (!secretsKeyOk()) throw new BadRequestException('defina SECRETS_KEY no .env do servidor antes de salvar (openssl rand -hex 32)');
    const current = await this.prisma.mailSettings.findUnique({ where: { id: 1 } });
    const i = parseMailSettings(asBody(body), current);
    const keep = <T>(v: string | undefined, old: T) => (v === undefined ? old : encryptSecret(v));
    const smtp = i.provider === 'smtp';
    const data = {
      provider: i.provider,
      fromAddress: i.fromAddress,
      fromName: i.fromName,
      portalUrl: i.portalUrl,
      smtpHost: i.smtpHost,
      smtpPort: i.smtpPort,
      smtpSecurity: i.smtpSecurity,
      smtpUser: i.smtpUser,
      // Trocar de provedor apaga a senha do outro; SMTP sem usuário não guarda senha.
      smtpPassword: smtp && i.smtpUser ? keep(i.smtpPassword, current?.smtpPassword ?? null) : null,
      msTenantId: i.msTenantId,
      msClientId: i.msClientId,
      msClientSecret: smtp ? null : keep(i.msClientSecret, current?.msClientSecret ?? null),
      updatedById: req.user.id,
      updatedByName: req.user.name,
    };
    await this.prisma.mailSettings.upsert({ where: { id: 1 }, create: { id: 1, ...data }, update: data });
    this.mailer.invalidate();
    await this.audit.record({
      userId: req.user.id,
      action: 'admin.mail.save',
      ip: req.ip,
      details: {
        provider: i.provider,
        from: i.fromAddress,
        smtp_host: i.smtpHost,
        smtp_user: i.smtpUser,
        ms_tenant_id: i.msTenantId,
        ms_client_id: i.msClientId,
        password_changed: i.smtpPassword !== undefined,
        secret_changed: i.msClientSecret !== undefined,
      },
    });
    return this.view();
  }

  @Post('test')
  @HttpCode(200)
  async test(@Req() req: PortalRequest, @Body() body: unknown) {
    const b = asBody(body);
    const to = parseRecipients(typeof b.to === 'string' && b.to.trim() ? b.to : req.user.email, true).slice(0, 1);
    const s = await this.mailer.settings();
    if (!s) throw new BadRequestException('salve a configuração antes de testar');
    const m = serverTestMail(await this.mailer.portalUrl(), req.user.name, s.provider);
    try {
      await this.mailer.send({ to, ...m });
    } catch (err) {
      throw new BadRequestException(`não foi possível enviar: ${(err as Error).message}`);
    }
    await this.audit.record({ userId: req.user.id, action: 'admin.mail.test', ip: req.ip, details: { to } });
    return { ok: true, to };
  }
}
