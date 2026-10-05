import type { Metadata } from 'next';
import { ActionForm } from '@/components/action-form';
import { TopBar } from '@/components/top-bar';
import { apiGet, requireAdmin } from '@/lib/api';
import { formatDateTimeShort } from '@/lib/format';
import { saveMail, testMail } from './actions';
import { MailFields, type MailView } from './mail-fields';

export const metadata: Metadata = { title: 'Servidor de e-mail · Tech Audit' };

// Servidor que envia os alertas e relatórios agendados de todas as empresas.
// Só o administrador da Tech Master.
export default async function MailPage() {
  const me = await requireAdmin();
  const v = await apiGet<MailView>('/api/admin/mail');
  return (
    <>
      <TopBar user={me} active="email" />
      <main className="page">
        <div className="title-row">
          <h1>Servidor de e-mail</h1>
        </div>
        <p className="muted small">
          Usado para os alertas e os relatórios agendados de todas as empresas.
          {v.configured
            ? ` Configuração salva${v.updated_by_name ? ` por ${v.updated_by_name}` : ''}${v.updated_at ? ` em ${formatDateTimeShort(v.updated_at)}` : ''}.`
            : ' Ainda não configurado: nenhum e-mail é enviado.'}
        </p>
        {!v.secrets_key_ok && (
          <p className="error">
            Falta a chave SECRETS_KEY no .env do servidor (ela criptografa a senha no banco). Gere com <code>openssl rand -hex 32</code>, coloque no .env e
            rode <code>docker compose up -d</code>.
          </p>
        )}

        <section className="card section">
          <ActionForm action={saveMail} submit="Salvar" className="stack-form">
            <MailFields v={v} />
          </ActionForm>
        </section>

        {v.configured && (
          <section className="card section">
            <h2>Testar</h2>
            <ActionForm action={testMail} submit="Enviar teste" className="inline-form">
              <label className="grow">
                Enviar para
                <input name="to" type="email" defaultValue={me.email} />
              </label>
            </ActionForm>
          </section>
        )}
      </main>
    </>
  );
}
