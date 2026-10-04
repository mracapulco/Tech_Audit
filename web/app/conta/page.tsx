import type { Metadata } from 'next';
import { TopBar } from '@/components/top-bar';
import { apiGet, type CurrentUser } from '@/lib/api';
import { roleLabel } from '@/lib/format';
import { ActionForm } from '@/components/action-form';
import { changeMyPassword, renameMe } from './actions';
import { MfaCard } from './mfa-card';

export const metadata: Metadata = { title: 'Minha conta · Tech Audit' };

export default async function AccountPage() {
  const [me, mfa] = await Promise.all([
    apiGet<CurrentUser>('/api/auth/me'),
    apiGet<{ enabled: boolean; required: boolean }>('/api/auth/mfa'),
  ]);
  return (
    <>
      <TopBar user={me} active="conta" />
      <main className="page">
        <h1>Minha conta</h1>
        <div className="card">
          <h3>Seus dados</h3>
          <p className="muted small">
            {me.email} · {roleLabel(me.role)}
          </p>
          <ActionForm action={renameMe} submit="Salvar nome" className="stack-form narrow">
            <label>
              Nome
              <input name="name" required maxLength={255} defaultValue={me.name} />
            </label>
          </ActionForm>
        </div>
        <div className="card">
          <h3>Senha</h3>
          <ActionForm action={changeMyPassword} submit="Alterar senha" className="stack-form narrow">
            <label>
              Senha atual
              <input name="current" type="password" required maxLength={200} autoComplete="current-password" />
            </label>
            <label>
              Nova senha
              <input name="password" type="password" required minLength={10} maxLength={200} autoComplete="new-password" placeholder="Mínimo de 10 caracteres" />
            </label>
            <label>
              Repita a nova senha
              <input name="confirm" type="password" required minLength={10} maxLength={200} autoComplete="new-password" />
            </label>
          </ActionForm>
        </div>
        <div className="card">
          <h3>Verificação em duas etapas</h3>
          <MfaCard enabled={mfa.enabled} required={mfa.required} />
        </div>
      </main>
    </>
  );
}
