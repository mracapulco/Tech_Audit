import Link from 'next/link';
import type { ReactNode } from 'react';
import { TopBar } from '@/components/top-bar';
import { apiGet, isMsp, type CurrentUser } from '@/lib/api';
import { formatLastDay, licenseStatus } from '@/lib/format';
import { withTenant, workspaceTabs, type TabKey } from '@/lib/workspace';

export interface TenantSummary {
  id: string;
  name: string;
  license: { status: string; plans: string[]; valid_until: string | null; max_agents: number; active_agents: number };
  agents: { ok: number; late: number; stale: number };
}

// Empresa da tela: a escolhida na URL (Tech Master) ou a do próprio cliente.
export function currentTenant(user: CurrentUser, fromUrl: string): string {
  return isMsp(user) ? fromUrl : (user.tenant_id ?? '');
}

// Moldura das telas da empresa: barra roxa, cabeçalho com nome, licença e as
// abas. Sem empresa escolhida, a Tech Master vê "Todas as empresas".
export async function Workspace({
  user,
  tenantId,
  tab,
  children,
  needsTenant = false,
}: {
  user: CurrentUser;
  tenantId: string;
  tab: TabKey;
  children: ReactNode;
  // Telas que só fazem sentido com uma empresa (servidores, usuários, licença).
  needsTenant?: boolean;
}) {
  const t = tenantId ? await apiGet<TenantSummary>(`/api/tenants/${tenantId}`) : null;
  const tabs = workspaceTabs(user.role, !!tenantId);
  const s = t ? licenseStatus(t.license.status) : null;
  return (
    <>
      <TopBar user={user} tenantId={isMsp(user) ? tenantId : ''} />
      <div className="ws-head">
        <div className="ws-inner">
          <div className="ws-title">
            <h1>{t?.name ?? 'Todas as empresas'}</h1>
            {t && s && (
              <dl className="ws-facts">
                <div>
                  <dt>Licença</dt>
                  <dd>
                    <span className={`pill ${s.tone}`}>
                      {s.label}
                      {t.license.valid_until && (t.license.status === 'active' || t.license.status === 'grace') ? ` até ${formatLastDay(t.license.valid_until)}` : ''}
                    </span>
                  </dd>
                </div>
                <div>
                  <dt>Servidores</dt>
                  <dd>
                    {t.license.active_agents} de {t.license.max_agents}
                  </dd>
                </div>
                {t.license.plans.length > 0 && (
                  <div>
                    <dt>Plano</dt>
                    <dd>{t.license.plans.join(' + ')}</dd>
                  </div>
                )}
              </dl>
            )}
          </div>
          <nav className="ws-tabs" aria-label="Telas da empresa">
            {tabs.map((x) => (
              <Link
                key={x.key}
                href={withTenant(x.path, isMsp(user) ? tenantId : '')}
                className={[x.key === tab ? 'active' : '', x.admin ? 'admin-only' : ''].join(' ').trim() || undefined}
                aria-current={x.key === tab ? 'page' : undefined}
              >
                {x.label}
              </Link>
            ))}
          </nav>
        </div>
      </div>
      <main className="page">{needsTenant && !tenantId ? <ChooseCompany tab={tab} /> : children}</main>
    </>
  );
}

// Tela que precisa de uma empresa, aberta em "Todas as empresas".
async function ChooseCompany({ tab }: { tab: TabKey }) {
  const tenants = await apiGet<{ id: string; name: string }[]>('/api/tenants');
  const path = `/${tab}`;
  return (
    <section className="section">
      <h2>Escolha a empresa</h2>
      {tenants.length === 0 ? (
        <p className="card empty">Nenhuma empresa cadastrada.</p>
      ) : (
        <ul className="card pick-list">
          {tenants.map((x) => (
            <li key={x.id}>
              <Link href={withTenant(path, x.id)}>{x.name}</Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
