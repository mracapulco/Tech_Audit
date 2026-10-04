import type { Metadata } from 'next';
import Link from 'next/link';
import { ActionForm } from '@/components/action-form';
import { Drawer } from '@/components/drawer';
import { TopBar } from '@/components/top-bar';
import { apiGet, requireAdmin } from '@/lib/api';
import { formatBytes, formatLastDay, licenseStatus } from '@/lib/format';
import { withTenant } from '@/lib/workspace';
import { createTenant } from '../actions';

export const metadata: Metadata = { title: 'Empresas · Tech Audit' };

interface TenantRow {
  id: string;
  name: string;
  license_status: string;
  valid_until: string | null;
  max_agents: number;
  max_volume_bytes: string;
  active_agents: number;
  active_users: number;
}

export default async function TenantsPage() {
  const user = await requireAdmin();
  const tenants = await apiGet<TenantRow[]>('/api/admin/tenants');
  return (
    <>
      <TopBar user={user} active="empresas" />
      <main className="page">
        <div className="title-row">
          <h1>Empresas</h1>
          <Drawer trigger="+ Cadastrar empresa" title="Cadastrar empresa">
            <ActionForm action={createTenant} submit="Cadastrar e criar a licença" className="stack-form">
              <label>
                Nome da empresa
                <input name="name" required maxLength={255} placeholder="Razão social ou nome fantasia" />
              </label>
              <p className="muted small">Depois do cadastro você vai direto para a licença da empresa.</p>
            </ActionForm>
          </Drawer>
        </div>
        <p className="muted small">Clique numa empresa para abrir o espaço dela: painel, servidores, usuários e licença.</p>

        {tenants.length === 0 ? (
          <p className="card empty">Nenhuma empresa cadastrada ainda.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Empresa</th>
                  <th>Licença</th>
                  <th>Vigente até</th>
                  <th>Servidores</th>
                  <th>Volume contratado</th>
                  <th>Usuários</th>
                </tr>
              </thead>
              <tbody>
                {tenants.map((t) => {
                  const s = licenseStatus(t.license_status);
                  const full = t.max_agents > 0 && t.active_agents >= t.max_agents;
                  return (
                    <tr key={t.id}>
                      <td>
                        <Link href={withTenant('/painel', t.id)}>{t.name}</Link>
                      </td>
                      <td>
                        <span className={`pill ${s.tone}`}>{s.label}</span>
                      </td>
                      <td className="nowrap">{formatLastDay(t.valid_until)}</td>
                      <td className={full ? 'warn-text' : undefined}>
                        {t.active_agents} de {t.max_agents}
                      </td>
                      <td>{t.max_agents ? formatBytes(t.max_volume_bytes) : '-'}</td>
                      <td>{t.active_users}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </main>
    </>
  );
}
