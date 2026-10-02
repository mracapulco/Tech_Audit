import Link from 'next/link';
import { logout } from '@/app/actions';
import { Logo } from '@/components/logo';
import type { CurrentUser } from '@/lib/api';

export function TopBar({ user, active }: { user: CurrentUser; active: 'painel' | 'eventos' | 'relatorios' | 'configuracao' | 'empresas' | 'usuarios' | 'conta' }) {
  const admin = user.role === 'msp_admin';
  const link = (key: typeof active, href: string, label: string) => (
    <Link href={href} className={active === key ? 'nav active' : 'nav'} aria-current={active === key ? 'page' : undefined}>
      {label}
    </Link>
  );
  return (
    <header className="topbar">
      <Link href="/painel" className="brand-link" aria-label="Tech Audit, ir para o painel">
        <Logo size={24} />
      </Link>
      <nav className="navlinks">
        {link('painel', '/painel', 'Painel')}
        {link('eventos', '/eventos', 'Eventos')}
        {link('relatorios', '/relatorios', 'Relatórios')}
        {link('configuracao', '/configuracao', 'Caminhos auditados')}
        {admin && link('empresas', '/admin/empresas', 'Empresas')}
        {admin && link('usuarios', '/admin/usuarios', 'Usuários')}
      </nav>
      <Link href="/conta" className={active === 'conta' ? 'muted who active' : 'muted who'} title="Minha conta">
        {user.name} · {user.email}
      </Link>
      <form action={logout}>
        <button type="submit" className="link">
          Sair
        </button>
      </form>
    </header>
  );
}
