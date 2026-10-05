// Tela "Servidor de e-mail" (menu Tech Master): leitura do formulário, sem
// acesso a banco. Senha e segredo em branco = manter os já salvos.
import { BadRequestException } from '@nestjs/common';
import { parseRecipients } from './rules.js';

export const PROVIDERS = ['microsoft365', 'smtp'] as const;
export const SMTP_SECURITY = ['starttls', 'tls', 'none'] as const;

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DOMAIN = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;
const HOST = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/i;

type Input = Record<string, unknown>;

const text = (b: Input, name: string, label: string, max: number): string | null => {
  const v = b[name];
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') throw new BadRequestException(`${label} inválido`);
  const t = v.trim();
  if (t.length > max) throw new BadRequestException(`${label} muito longo`);
  return t || null;
};

export interface MailSettingsInput {
  provider: (typeof PROVIDERS)[number];
  fromAddress: string;
  fromName: string;
  portalUrl: string | null;
  smtpHost: string | null;
  smtpPort: number | null;
  smtpSecurity: (typeof SMTP_SECURITY)[number] | null;
  smtpUser: string | null;
  // undefined = manter a salva.
  smtpPassword: string | undefined;
  msTenantId: string | null;
  msClientId: string | null;
  msClientSecret: string | undefined;
}

export function parseMailSettings(b: Input, current: { smtpPassword: string | null; msClientSecret: string | null } | null): MailSettingsInput {
  const provider = b.provider as MailSettingsInput['provider'];
  if (!(PROVIDERS as readonly unknown[]).includes(provider)) throw new BadRequestException('escolha Microsoft 365 ou SMTP');
  const from = text(b, 'from_address', 'Remetente', 254);
  if (!from) throw new BadRequestException('informe o e-mail remetente');
  const fromAddress = parseRecipients(from, true)[0];
  const portalUrl = text(b, 'portal_url', 'Endereço do portal', 300);
  if (portalUrl && !/^https?:\/\/[^\s/]+(\/[^\s]*)?$/i.test(portalUrl)) throw new BadRequestException('o endereço do portal deve começar com https://');
  const secret = (name: string, label: string) => {
    const v = text(b, name, label, 1000);
    return v ?? undefined;
  };
  const out: MailSettingsInput = {
    provider,
    fromAddress,
    fromName: text(b, 'from_name', 'Nome do remetente', 100) ?? 'Tech Audit',
    portalUrl: portalUrl?.replace(/\/$/, '') ?? null,
    smtpHost: null,
    smtpPort: null,
    smtpSecurity: null,
    smtpUser: null,
    smtpPassword: undefined,
    msTenantId: null,
    msClientId: null,
    msClientSecret: undefined,
  };
  if (provider === 'microsoft365') {
    const tenant = text(b, 'ms_tenant_id', 'ID do locatário', 253);
    if (!tenant || !(GUID.test(tenant) || DOMAIN.test(tenant))) throw new BadRequestException('informe o ID do locatário (Directory/tenant ID) do Entra ID');
    const client = text(b, 'ms_client_id', 'ID do aplicativo', 36);
    if (!client || !GUID.test(client)) throw new BadRequestException('informe o ID do aplicativo (Application/client ID) do Entra ID');
    out.msTenantId = tenant.toLowerCase();
    out.msClientId = client.toLowerCase();
    out.msClientSecret = secret('ms_client_secret', 'Segredo do aplicativo');
    if (out.msClientSecret === undefined && !current?.msClientSecret) throw new BadRequestException('informe o segredo do aplicativo (client secret)');
    return out;
  }
  const host = text(b, 'smtp_host', 'Servidor SMTP', 253);
  if (!host || !HOST.test(host)) throw new BadRequestException('informe o endereço do servidor SMTP');
  const portRaw = b.smtp_port === undefined || b.smtp_port === '' ? 587 : Number(b.smtp_port);
  if (!Number.isInteger(portRaw) || portRaw < 1 || portRaw > 65535) throw new BadRequestException('porta SMTP inválida');
  const security = (b.smtp_security ?? 'starttls') as MailSettingsInput['smtpSecurity'];
  if (!(SMTP_SECURITY as readonly unknown[]).includes(security)) throw new BadRequestException('segurança SMTP inválida');
  out.smtpHost = host.toLowerCase();
  out.smtpPort = portRaw;
  out.smtpSecurity = security;
  out.smtpUser = text(b, 'smtp_user', 'Usuário SMTP', 254);
  out.smtpPassword = out.smtpUser ? secret('smtp_password', 'Senha SMTP') : undefined;
  if (out.smtpUser && out.smtpPassword === undefined && !current?.smtpPassword) throw new BadRequestException('informe a senha do usuário SMTP');
  return out;
}
