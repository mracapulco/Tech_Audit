import type { Metadata } from 'next';
import Link from 'next/link';
import { ActionForm } from '@/components/action-form';
import { TopBar } from '@/components/top-bar';
import { apiGet, requireAdmin } from '@/lib/api';
import { formatDateTimeShort, roleLabel } from '@/lib/format';
import { createUser, deleteUser, resetPassword, setUserDisabled } from '../actions';

export const metadata: Metadata = { title: 'Usuários · Tech Audit' };

interface UserRow {
  id: string;
  name: string;
  email: string;
  role: string;
  tenant_id: string | null;
  tenant_name: string | null;
  last_login_at: string | null;
  disabled_at: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function UsersPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const empresa = typeof sp.empresa === 'string' && UUID.test(sp.empresa) ? sp.empresa : '';
  const me = await requireAdmin();
  const [users, tenants] = await Promise.all([
    apiGet<UserRow[]>(`/api/admin/users${empresa ? `?tenant=${empresa}` : ''}`),
    apiGet<{ id: string; name: string }[]>('/api/tenants'),
  ]);

  return (
    <>
      <TopBar user={me} active="usuarios" />
      <main className="page">
        <h1>Usuários</h1>

        <div className="card">
            <h3>Novo usuário</h3>
          <ActionForm action={createUser} submit="Cadastrar usuário" className="grid-form">
            <label>
              Nome
              <input name="name" required maxLength={255} />
            </label>
            <label>
              E-mail
              <input name="email" type="email" required maxLength={255} />
            </label>
            <label>
              Perfil
              <select name="role" defaultValue="tenant_auditor">
                <option value="tenant_auditor">Cliente (vê só a própria empresa)</option>
                <option value="msp_admin">Administrador (Tech Master, acesso total)</option>
              </select>
            </label>
            <label>
              Empresa (para perfil Cliente)
              <select name="tenant_id" defaultValue={empresa}>
                <option value="">Selecione…</option>
                {tenants.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Senha inicial
              <input name="password" type="password" minLength={10} maxLength={200} autoComplete="new-password" placeholder="Em branco: gerar automaticamente" />
            </label>
          </ActionForm>
        </div>

        <form method="get" className="filter-row">
          <label>
            Empresa
            <select name="empresa" defaultValue={empresa}>
              <option value="">Todas, incluindo administradores</option>
              {tenants.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className="secondary">
            Filtrar
          </button>
          {empresa && <Link href={`/admin/empresas/${empresa}`}>Ver empresa</Link>}
        </form>

        {users.length === 0 ? (
          <p className="card empty">Nenhum usuário encontrado.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Nome</th>
                  <th>E-mail</th>
                  <th>Perfil</th>
                  <th>Empresa</th>
                  <th>Último acesso</th>
                  <th>Situação</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id} className={u.disabled_at ? 'dim' : undefined}>
                    <td>{u.name}</td>
                    <td>{u.email}</td>
                    <td>{roleLabel(u.role)}</td>
                    <td>{u.tenant_name ?? 'Tech Master'}</td>
                    <td className="nowrap">{formatDateTimeShort(u.last_login_at)}</td>
                    <td>{u.disabled_at ? <span className="pill neutral">Desativado</span> : <span className="pill ok">Ativo</span>}</td>
                    <td>
                      <div className="row-actions">
                        {u.id !== me.id &&
                          (u.disabled_at ? (
                            <ActionForm action={setUserDisabled.bind(null, u.id, false)} submit="Reativar" secondary />
                          ) : (
                            <ActionForm
                              action={setUserDisabled.bind(null, u.id, true)}
                              submit="Desativar"
                              secondary
                              confirm={`Desativar ${u.email}? A pessoa sai do portal na hora.`}
                            />
                          ))}
                        <ActionForm
                          action={resetPassword.bind(null, u.id)}
                          submit="Nova senha"
                          secondary
                          confirm={`Gerar uma nova senha para ${u.email}? A senha atual deixa de funcionar.`}
                        />
                        {u.id !== me.id && (
                          <ActionForm
                            action={deleteUser.bind(null, u.id)}
                            submit="Excluir"
                            secondary
                            confirm={`Excluir ${u.email} de vez? Não dá para desfazer; o histórico de acessos continua guardado.`}
                          />
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </main>
    </>
  );
}
