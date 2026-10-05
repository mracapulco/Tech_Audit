import { Injectable } from '@nestjs/common';
import nodemailer from 'nodemailer';
import { PrismaService } from '../prisma.service.js';
import { GraphMailer, type FetchFn } from './graph.js';
import { decryptSecret } from './secrets.js';

export interface MailAttachment {
  filename: string;
  content: Buffer;
  contentType: string;
}

export interface Mail {
  to: string[];
  subject: string;
  text: string;
  html: string;
  attachments?: MailAttachment[];
}

// Transporte trocável nos testes.
export type MailTransport = { sendMail(m: Record<string, unknown>): Promise<unknown> };

export class MailNotConfiguredError extends Error {
  constructor() {
    super('servidor de e-mail não configurado (menu Tech Master > Servidor de e-mail)');
  }
}

type Settings = NonNullable<Awaited<ReturnType<PrismaService['mailSettings']['findUnique']>>>;

interface Sender {
  send(m: Mail): Promise<void>;
}

// Envio de e-mail com o servidor configurado no portal (tabela mail_settings):
// Microsoft 365 pela Graph (OAuth, autenticação moderna) ou SMTP comum.
@Injectable()
export class MailerService {
  private override: MailTransport | null | undefined = undefined;
  private cached: { at: number; settings: Settings | null; sender: Sender | null } | null = null;
  // Só para os testes da Graph.
  fetchFn: FetchFn = fetch;

  constructor(private readonly prisma: PrismaService) {}

  // Só para os testes: null = sem servidor configurado.
  useTransport(t: MailTransport | null) {
    this.override = t;
  }

  // A tela salvou: o próximo envio relê a configuração.
  invalidate() {
    this.cached = null;
  }

  async settings(): Promise<Settings | null> {
    if (!this.cached || Date.now() - this.cached.at > 60_000) {
      const settings = await this.prisma.mailSettings.findUnique({ where: { id: 1 } });
      this.cached = { at: Date.now(), settings, sender: null };
    }
    return this.cached.settings;
  }

  async configured(): Promise<boolean> {
    if (this.override !== undefined) return this.override !== null;
    return (await this.settings()) !== null;
  }

  // Endereço do portal para os links dos e-mails.
  async portalUrl(): Promise<string> {
    return ((await this.settings())?.portalUrl ?? '').trim().replace(/\/$/, '');
  }

  private build(s: Settings): Sender {
    const fromName = s.fromName || 'Tech Audit';
    if (s.provider === 'microsoft365') {
      const g = new GraphMailer(
        { tenantId: s.msTenantId ?? '', clientId: s.msClientId ?? '', clientSecret: decryptSecret(s.msClientSecret ?? ''), from: s.fromAddress, fromName },
        (url, init) => this.fetchFn(url, init),
      );
      return g;
    }
    const port = s.smtpPort ?? 587;
    const security = s.smtpSecurity ?? 'starttls';
    const t = nodemailer.createTransport({
      host: s.smtpHost ?? '',
      port,
      secure: security === 'tls',
      requireTLS: security === 'starttls',
      ignoreTLS: security === 'none',
      auth: s.smtpUser ? { user: s.smtpUser, pass: s.smtpPassword ? decryptSecret(s.smtpPassword) : '' } : undefined,
      connectionTimeout: 20_000,
      greetingTimeout: 20_000,
      socketTimeout: 60_000,
      // Anexos e corpo vêm só do próprio servidor; nada de arquivos ou URLs.
      disableFileAccess: true,
      disableUrlAccess: true,
    });
    const from = { name: fromName, address: s.fromAddress };
    return {
      send: async (m) => {
        await t.sendMail({ from, to: m.to, subject: m.subject, text: m.text, html: m.html, attachments: m.attachments });
      },
    };
  }

  async send(m: Mail): Promise<void> {
    if (this.override === null) throw new MailNotConfiguredError();
    if (this.override) {
      await this.override.sendMail({ to: m.to, subject: m.subject, text: m.text, html: m.html, attachments: m.attachments });
      return;
    }
    const s = await this.settings();
    if (!s) throw new MailNotConfiguredError();
    if (!this.cached!.sender) this.cached!.sender = this.build(s);
    await this.cached!.sender.send(m);
  }

}
