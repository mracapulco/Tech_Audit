import { Injectable } from '@nestjs/common';
import nodemailer, { type Transporter } from 'nodemailer';

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
    super('envio de e-mail não configurado no servidor (SMTP_HOST no .env)');
  }
}

// Envio de e-mail por SMTP, configurado no .env (SMTP_HOST, SMTP_PORT,
// SMTP_SECURE, SMTP_USER, SMTP_PASSWORD, SMTP_FROM). Sem SMTP_HOST, nada é
// enviado e os envios ficam registrados como não configurados.
@Injectable()
export class MailerService {
  private transport: MailTransport | null = null;
  private readonly from = process.env.SMTP_FROM || 'Tech Audit <nao-responda@techmaster.inf.br>';

  constructor() {
    const host = process.env.SMTP_HOST?.trim();
    if (!host) return;
    const port = Number(process.env.SMTP_PORT || 587);
    const user = process.env.SMTP_USER?.trim();
    this.transport = nodemailer.createTransport({
      host,
      port,
      // 465 = TLS direto; 587/25 = STARTTLS, exigido quando há usuário e senha.
      secure: (process.env.SMTP_SECURE ?? String(port === 465)) === 'true',
      requireTLS: !!user && port !== 465,
      auth: user ? { user, pass: process.env.SMTP_PASSWORD ?? '' } : undefined,
      connectionTimeout: 20_000,
      greetingTimeout: 20_000,
      socketTimeout: 60_000,
      // Anexos e corpo vêm só do próprio servidor; nada de arquivos ou URLs.
      disableFileAccess: true,
      disableUrlAccess: true,
    }) as Transporter;
  }

  get configured(): boolean {
    return this.transport !== null;
  }

  // Só para os testes.
  useTransport(t: MailTransport | null) {
    this.transport = t;
  }

  async send(m: Mail): Promise<void> {
    if (!this.transport) throw new MailNotConfiguredError();
    await this.transport.sendMail({
      from: this.from,
      to: m.to,
      subject: m.subject,
      text: m.text,
      html: m.html,
      attachments: m.attachments,
    });
  }
}
