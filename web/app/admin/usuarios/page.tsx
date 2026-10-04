import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { TopBar } from '@/components/top-bar';
import { NewUser, UsersTable, type UserRow } from '@/components/users-table';
import { apiGet, requireAdmin } from '@/lib/api';
import { tenantParam, withTenant } from '@/lib/workspace';

export const metadata: Metadata = { title: 'Equipe Tech Master · Tech Audit' };

// Equipe da Tech Master. Os usuários de cada cliente ficam na aba Usuários da empresa.
export default async function TeamPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const me = await requireAdmin();
  const tenant = tenantParam(await searchParams);
  if (tenant) redirect(withTenant('/usuarios', tenant));
  const users = (await apiGet<UserRow[]>('/api/admin/users')).filter((u) => !u.tenant_id);
  return (
    <>
      <TopBar user={me} active="equipe" />
      <main className="page">
        <div className="title-row">
          <h1>Equipe Tech Master</h1>
          <NewUser />
        </div>
        <p className="muted small">Pessoas da Tech Master com acesso a todas as empresas. A verificação em duas etapas é obrigatória para elas.</p>
        <UsersTable users={users} meId={me.id} empty="Nenhum usuário da Tech Master." />
      </main>
    </>
  );
}
