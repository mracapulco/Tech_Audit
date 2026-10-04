import type { Metadata } from 'next';
import { NewUser, UsersTable, type UserRow } from '@/components/users-table';
import { currentTenant, Workspace } from '@/components/workspace';
import { apiGet, requireAdmin } from '@/lib/api';
import { tenantParam } from '@/lib/workspace';

export const metadata: Metadata = { title: 'Usuários · Tech Audit' };

// Aba Usuários da empresa: quem do cliente acessa o portal.
export default async function TenantUsersPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const me = await requireAdmin();
  const tenantId = currentTenant(me, tenantParam(await searchParams));
  const users = tenantId ? await apiGet<UserRow[]>(`/api/admin/users?tenant=${tenantId}`) : [];
  return (
    <Workspace user={me} tenantId={tenantId} tab="usuarios" needsTenant>
      <div className="title-row">
        <h2 className="page-title">Usuários</h2>
        <NewUser tenantId={tenantId} />
      </div>
      <UsersTable users={users} meId={me.id} empty="Nenhum usuário nesta empresa ainda." />
    </Workspace>
  );
}
