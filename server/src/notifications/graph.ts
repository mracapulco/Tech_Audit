// Envio pelo Microsoft 365 (Exchange Online) com autenticação moderna: OAuth
// 2.0 de aplicativo (client credentials) e a API Microsoft Graph. Precisa de um
// registro de aplicativo no Entra ID com a permissão de aplicativo Mail.Send.
import type { Mail } from './mailer.service.js';

export interface GraphConfig {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  // Caixa que envia (o remetente).
  from: string;
  fromName: string;
}

export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

const GRAPH = 'https://graph.microsoft.com/v1.0';
// Acima disso o anexo vai por sessão de upload (o sendMail aceita até ~4 MB no total).
const INLINE_LIMIT = 3 * 1024 * 1024;
const CHUNK = 4 * 320 * 1024; // múltiplo de 320 KiB, como a Graph pede

async function fail(r: Response, what: string): Promise<never> {
  let detail = r.statusText;
  try {
    const b = (await r.json()) as { error?: { message?: string; code?: string } | string; error_description?: string };
    if (typeof b.error === 'string') detail = b.error_description?.split('\r\n')[0] ?? b.error;
    else if (b.error) detail = `${b.error.code ?? ''} ${b.error.message ?? ''}`.trim();
  } catch {
    // corpo sem JSON
  }
  throw new Error(`${what} (HTTP ${r.status}): ${detail}`.slice(0, 500));
}

export class GraphMailer {
  private token: { value: string; expires: number } | null = null;

  constructor(
    private readonly cfg: GraphConfig,
    private readonly fetchFn: FetchFn = fetch,
  ) {}

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expires > Date.now() + 60_000) return this.token.value;
    const r = await this.fetchFn(`https://login.microsoftonline.com/${encodeURIComponent(this.cfg.tenantId)}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.cfg.clientId,
        client_secret: this.cfg.clientSecret,
        scope: 'https://graph.microsoft.com/.default',
        grant_type: 'client_credentials',
      }).toString(),
    });
    if (!r.ok) await fail(r, 'login no Microsoft 365 recusado');
    const b = (await r.json()) as { access_token: string; expires_in: number };
    this.token = { value: b.access_token, expires: Date.now() + b.expires_in * 1000 };
    return b.access_token;
  }

  private async call(method: string, path: string, body?: unknown): Promise<Response> {
    const r = await this.fetchFn(`${GRAPH}${path}`, {
      method,
      headers: { authorization: `Bearer ${await this.accessToken()}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!r.ok) await fail(r, 'o Microsoft 365 recusou o envio');
    return r;
  }

  private message(m: Mail) {
    return {
      subject: m.subject,
      body: { contentType: 'HTML', content: m.html },
      from: { emailAddress: { address: this.cfg.from, name: this.cfg.fromName } },
      toRecipients: m.to.map((address) => ({ emailAddress: { address } })),
    };
  }

  async send(m: Mail): Promise<void> {
    const user = `/users/${encodeURIComponent(this.cfg.from)}`;
    const files = m.attachments ?? [];
    const size = files.reduce((n, a) => n + a.content.length, 0);
    if (size <= INLINE_LIMIT) {
      await this.call('POST', `${user}/sendMail`, {
        message: {
          ...this.message(m),
          attachments: files.map((a) => ({
            '@odata.type': '#microsoft.graph.fileAttachment',
            name: a.filename,
            contentType: a.contentType,
            contentBytes: a.content.toString('base64'),
          })),
        },
        saveToSentItems: false,
      });
      return;
    }
    // Anexo grande: rascunho, upload em partes e envio.
    const draft = (await (await this.call('POST', `${user}/messages`, this.message(m))).json()) as { id: string };
    const msg = `${user}/messages/${encodeURIComponent(draft.id)}`;
    for (const a of files) {
      const s = (await (
        await this.call('POST', `${msg}/attachments/createUploadSession`, {
          AttachmentItem: { attachmentType: 'file', name: a.filename, size: a.content.length, contentType: a.contentType },
        })
      ).json()) as { uploadUrl: string };
      for (let start = 0; start < a.content.length; start += CHUNK) {
        const part = a.content.subarray(start, start + CHUNK);
        // A URL de upload já é autorizada; não leva o token.
        const r = await this.fetchFn(s.uploadUrl, {
          method: 'PUT',
          headers: {
            'content-type': 'application/octet-stream',
            'content-range': `bytes ${start}-${start + part.length - 1}/${a.content.length}`,
          },
          body: new Uint8Array(part),
        });
        if (!r.ok) await fail(r, 'falha ao enviar o anexo ao Microsoft 365');
      }
    }
    await this.call('POST', `${msg}/send`);
  }
}
