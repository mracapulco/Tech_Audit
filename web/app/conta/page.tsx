import type { Metadata } from 'next';
import { TopBar } from '@/components/top-bar';
import { apiGet, type CurrentUser } from '@/lib/api';
import { roleLabel } from '@/lib/format';
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
          <p>
            <strong>{me.name}</strong> · {me.email} · {roleLabel(me.role)}
          </p>
        </div>
        <div className="card">
          <h3>Verificação em duas etapas</h3>
          <MfaCard enabled={mfa.enabled} required={mfa.required} />
        </div>
      </main>
    </>
  );
}
