import Link from 'next/link';
import { ActionForm } from '@/components/action-form';
import { Drawer } from '@/components/drawer';
import { Menu } from '@/components/menu';
import { deleteUser, createUser, renameUser, resetMfa, resetPassword, setUserDisabled } from '@/app/admin/actions';
import { formatDateTimeShort, roleLabel } from '@/lib/format';

export interface UserRow {
  id: string;
  name: string;
  email: string;
  role: string;
  tenant_id: string | null;
  tenant_name: string | null;
  last_login_at: string | null;
  disabled_at: string | null;
  mfa_enabled: boolean;
}

// Lista de usuários com as ações no menu ⋯ de cada linha. Usada na aba
// Usuários da empresa e na Equipe Tech Master.
export function UsersTable({ users, meId, empty }: { users: UserRow[]; meId: string; empty: string }) {
  if (users.length === 0) return <p className="card empty">{empty}</p>;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Nome</th>
            <th>E-mail</th>
            <th>Perfil</th>
            <th>Último acesso</th>
            <th>Situação</th>
            <th>Duas etapas</th>
            <th aria-label="Ações"></th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id} className={u.disabled_at ? 'dim' : undefined}>
              <td>{u.name}</td>
              <td>{u.email}</td>
              <td>{roleLabel(u.role)}</td>
              <td className="nowrap">{formatDateTimeShort(u.last_login_at)}</td>
              <td>{u.disabled_at ? <span className="pill neutral">Desativado</span> : <span className="pill ok">Ativo</span>}</td>
              <td>{u.mfa_enabled ? <span className="pill ok">Ativa</span> : <span className="pill neutral">Não</span>}</td>
              <td className="cell-menu">
                <Menu label="⋯" ariaLabel={`Ações de ${u.email}`}>
                  {u.id === meId ? (
                    <Link className="menu-item" href="/conta">
                      Alterar meu nome ou senha
                    </Link>
                  ) : (
                    <>
                      <Drawer trigger="Editar nome" triggerClass="menu-item" title={`Editar ${u.email}`}>
                        <ActionForm action={renameUser.bind(null, u.id)} submit="Salvar" className="stack-form">
                          <label>
                            Nome
                            <input name="name" required maxLength={255} defaultValue={u.name} />
                          </label>
                        </ActionForm>
                      </Drawer>
                      <Drawer trigger="Trocar senha" triggerClass="menu-item" title={`Trocar a senha de ${u.email}`}>
                        <PasswordForm userId={u.id} />
                      </Drawer>
                    </>
                  )}
                  {u.mfa_enabled && u.id !== meId && (
                    <ActionForm
                      action={resetMfa.bind(null, u.id)}
                      submit="Redefinir duas etapas"
                      menu
                      confirm={`Redefinir a verificação em duas etapas de ${u.email}? Use quando a pessoa perdeu ou trocou o celular. No próximo login ela cadastra o aplicativo de novo.`}
                    />
                  )}
                  {u.id !== meId && (
                    <>
                      {u.disabled_at ? (
                        <ActionForm action={setUserDisabled.bind(null, u.id, false)} submit="Reativar" menu />
                      ) : (
                        <ActionForm action={setUserDisabled.bind(null, u.id, true)} submit="Desativar" menu confirm={`Desativar ${u.email}? A pessoa sai do portal na hora.`} />
                      )}
                      <div className="sep" />
                      <ActionForm
                        action={deleteUser.bind(null, u.id)}
                        submit="Excluir"
                        menu="danger"
                        confirm={`Excluir ${u.email} de vez? Não dá para desfazer; o histórico de acessos continua guardado.`}
                      />
                    </>
                  )}
                </Menu>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Botão "+ Novo usuário" com o cadastro no painel lateral. Com empresa, só os
// perfis de cliente; sem empresa, a equipe da Tech Master.
export function NewUser({ tenantId }: { tenantId?: string }) {
  return (
    <Drawer trigger="+ Novo usuário" title={tenantId ? 'Novo usuário da empresa' : 'Novo usuário da Tech Master'}>
      <ActionForm action={createUser} submit="Cadastrar usuário" className="stack-form">
        {tenantId && <input type="hidden" name="tenant_id" value={tenantId} />}
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
          {tenantId ? (
            <select name="role" defaultValue="tenant_auditor">
              <option value="tenant_auditor">Cliente (consulta eventos e relatórios)</option>
              <option value="tenant_admin">Cliente administrador (também instala agentes e escolhe as pastas)</option>
            </select>
          ) : (
            <select name="role" defaultValue="msp_admin">
              <option value="msp_admin">Administrador (acesso total)</option>
            </select>
          )}
        </label>
        <label>
          Senha inicial
          <input name="password" type="password" minLength={10} maxLength={200} autoComplete="new-password" placeholder="Em branco: gerar automaticamente" />
        </label>
      </ActionForm>
    </Drawer>
  );
}

// Senha escolhida pelo administrador, ou gerada pelo portal se ficar em branco.
function PasswordForm({ userId }: { userId: string }) {
  return (
    <ActionForm action={resetPassword.bind(null, userId)} submit="Trocar senha" className="stack-form" confirm="Trocar a senha? A atual deixa de funcionar e as sessões abertas são encerradas.">
      <p className="muted small">Deixe em branco para o portal gerar uma senha forte e mostrar uma única vez.</p>
      <label>
        Nova senha
        <input name="password" type="password" minLength={10} maxLength={200} autoComplete="new-password" placeholder="Mínimo de 10 caracteres" />
      </label>
      <label>
        Repita a nova senha
        <input name="confirm" type="password" minLength={10} maxLength={200} autoComplete="new-password" />
      </label>
    </ActionForm>
  );
}
