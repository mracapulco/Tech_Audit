import Link from 'next/link';
import { logout } from '@/app/actions';
import type { CurrentUser } from '@/lib/api';

export function TopBar({ user, active }: { user: CurrentUser; active: 'eventos' | 'configuracao' | 'empresas' | 'usuarios' }) {
  const admin = user.role === 'msp_admin';
  const link = (key: typeof active, href: string, label: string) => (
    <Link href={href} className={active === key ? 'nav active' : 'nav'} aria-current={active === key ? 'page' : undefined}>
      {label}
    </Link>
  );
  return (
    <header className="topbar">
      <strong>Tech Audit</strong>
      <nav className="navlinks">
        {link('eventos', '/eventos', 'Eventos')}
        {link('configuracao', '/configuracao', 'Caminhos auditados')}
        {admin && link('empresas', '/admin/empresas', 'Empresas')}
        {admin && link('usuarios', '/admin/usuarios', 'Usuários')}
      </nav>
      <span className="muted who">
        {user.name} · {user.email}
      </span>
      <form action={logout}>
        <button type="submit" className="link">
          Sair
        </button>
      </form>
    </header>
  );
}
