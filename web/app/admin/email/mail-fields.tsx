'use client';

import { useState } from 'react';

export interface MailView {
  configured: boolean;
  secrets_key_ok: boolean;
  provider: string;
  from_address: string;
  from_name: string;
  portal_url: string;
  smtp_host: string;
  smtp_port: number;
  smtp_security: string;
  smtp_user: string;
  has_smtp_password: boolean;
  ms_tenant_id: string;
  ms_client_id: string;
  has_ms_client_secret: boolean;
  updated_at: string | null;
  updated_by_name: string | null;
}

// Campos da tela "Servidor de e-mail": mostra só os do provedor escolhido.
// Senha e segredo em branco mantêm os já salvos.
export function MailFields({ v }: { v: MailView }) {
  const [provider, setProvider] = useState(v.provider);
  const keep = 'Deixe em branco para manter o já salvo';
  return (
    <>
      <fieldset className="checks">
        <legend className="small muted">Provedor</legend>
        <label className="check">
          <input type="radio" name="provider" value="microsoft365" checked={provider === 'microsoft365'} onChange={() => setProvider('microsoft365')} /> Microsoft 365 /
          Exchange Online (autenticação moderna, OAuth)
        </label>
        <label className="check">
          <input type="radio" name="provider" value="smtp" checked={provider === 'smtp'} onChange={() => setProvider('smtp')} /> Outro servidor SMTP (usuário e
          senha)
        </label>
      </fieldset>

      <div className="inline-form">
        <label className="grow">
          E-mail remetente
          <input name="from_address" type="email" required maxLength={254} defaultValue={v.from_address} placeholder="nao-responda@techmaster.inf.br" />
        </label>
        <label className="grow">
          Nome do remetente
          <input name="from_name" maxLength={100} defaultValue={v.from_name} />
        </label>
      </div>

      {provider === 'microsoft365' ? (
        <>
          <p className="notice small">
            No Entra ID (portal.azure.com): registre um aplicativo, crie um segredo e dê a permissão de <strong>aplicativo</strong> Mail.Send do Microsoft
            Graph, com consentimento do administrador. O e-mail remetente precisa ser uma caixa (ou caixa compartilhada) do Exchange Online.
          </p>
          <label>
            ID do locatário (Directory / tenant ID)
            <input name="ms_tenant_id" required maxLength={253} defaultValue={v.ms_tenant_id} placeholder="00000000-0000-0000-0000-000000000000" />
          </label>
          <label>
            ID do aplicativo (Application / client ID)
            <input name="ms_client_id" required maxLength={36} defaultValue={v.ms_client_id} placeholder="00000000-0000-0000-0000-000000000000" />
          </label>
          <label>
            Segredo do aplicativo (client secret, o "Valor")
            <input name="ms_client_secret" type="password" autoComplete="new-password" maxLength={1000} placeholder={v.has_ms_client_secret ? keep : ''} required={!v.has_ms_client_secret} />
          </label>
        </>
      ) : (
        <>
          <div className="inline-form">
            <label className="grow">
              Servidor SMTP
              <input name="smtp_host" required maxLength={253} defaultValue={v.smtp_host} placeholder="smtp.exemplo.com.br" />
            </label>
            <label>
              Porta
              <input name="smtp_port" type="number" min={1} max={65535} defaultValue={v.smtp_port} />
            </label>
            <label>
              Segurança
              <select name="smtp_security" defaultValue={v.smtp_security}>
                <option value="starttls">STARTTLS (porta 587)</option>
                <option value="tls">TLS direto (porta 465)</option>
                <option value="none">Nenhuma (só rede interna)</option>
              </select>
            </label>
          </div>
          <div className="inline-form">
            <label className="grow">
              Usuário (vazio = sem autenticação)
              <input name="smtp_user" maxLength={254} autoComplete="off" defaultValue={v.smtp_user} />
            </label>
            <label className="grow">
              Senha
              <input name="smtp_password" type="password" autoComplete="new-password" maxLength={1000} placeholder={v.has_smtp_password ? keep : ''} />
            </label>
          </div>
        </>
      )}

      <label>
        Endereço do portal (para os links nos e-mails)
        <input name="portal_url" maxLength={300} defaultValue={v.portal_url} placeholder="https://audit.techmaster.inf.br" />
      </label>
    </>
  );
}
