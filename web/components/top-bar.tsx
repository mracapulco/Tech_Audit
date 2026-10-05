import Link from 'next/link';
import { logout } from '@/app/actions';
import { canDownloadAgent } from '@/lib/agent';
import { Logo } from '@/components/logo';
import { Menu } from '@/components/menu';
import { TenantSwitch } from '@/components/tenant-switch';
import { apiGet, isMsp, type CurrentUser } from '@/lib/api';

export type TopBarActive = 'empresas' | 'equipe' | 'agente' | 'limpeza' | 'email' | 'conta';

// Barra roxa: empresa em uso à esquerda (a Tech Master troca por aqui), menu
// das telas da Tech Master e menu da pessoa à direita.
export async function TopBar({ user, tenantId = '', active }: { user: CurrentUser; tenantId?: string; active?: TopBarActive }) {
  const msp = isMsp(user);
  const admin = user.role === 'msp_admin';
  // Para o cliente, a lista traz só a própria empresa.
  const tenants = await apiGet<{ id: string; name: string }[]>('/api/tenants');
  const item = (key: TopBarActive, href: string, label: string, hint?: string) => (
    <Link href={href} className={active === key ? 'menu-item active' : 'menu-item'} aria-current={active === key ? 'page' : undefined}>
      {label}
      {hint && <span className="hint">{hint}</span>}
    </Link>
  );
  const initials = user.name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('');

  return (
    <header className="topbar">
      <Link href="/painel" className="brand-link" aria-label="Tech Audit, ir para o painel">
        <Logo size={24} />
      </Link>
      {msp ? (
        <nav className="tenant-nav" aria-label="Empresa">
          <Link href="/painel" className={tenantId || active ? 'tb-link' : 'tb-link current'}>
            Todas as empresas
          </Link>
          <span className="tb-sep" aria-hidden="true">
            ›
          </span>
          <TenantSwitch role={user.role} tenants={tenants} current={tenantId} />
        </nav>
      ) : (
        <span className="tenant-name">{tenants[0]?.name}</span>
      )}
      <span className="tb-spacer" />
      {(admin || (msp && canDownloadAgent(user.role))) && (
        <Menu label={<>Tech Master ▾</>} buttonClass={active && active !== 'conta' ? 'tb-link current' : 'tb-link'}>
          <span className="menu-label">Tech Master</span>
          {admin && item('empresas', '/admin/empresas', 'Empresas', 'cadastro e licenças')}
          {admin && item('equipe', '/admin/usuarios', 'Equipe Tech Master')}
          {item('agente', '/agente', 'Instaladores do agente')}
          {admin && item('limpeza', '/admin/limpeza', 'Limpeza de dados')}
          {admin && item('email', '/admin/email', 'Servidor de e-mail', 'alertas e relatórios')}
        </Menu>
      )}
      <Menu
        label={
          <>
            <span className="avatar" aria-hidden="true">
              {initials}
            </span>
            <span className="who-name">{user.name}</span>
          </>
        }
        buttonClass={active === 'conta' ? 'tb-link current' : 'tb-link'}
        ariaLabel={`Conta de ${user.name}`}
      >
        <span className="menu-label">{user.email}</span>
        {item('conta', '/conta', 'Minha conta', 'senha e duas etapas')}
        <div className="sep" />
        <form action={logout}>
          <button type="submit" className="menu-item">
            Sair
          </button>
        </form>
      </Menu>
    </header>
  );
}
