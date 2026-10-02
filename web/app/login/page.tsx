import type { Metadata } from 'next';
import { Logo } from '@/components/logo';
import { LoginForm } from './login-form';

export const metadata: Metadata = { title: 'Entrar · Tech Audit' };

export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  return (
    <main className="login-page">
      <section className="login-brand">
        <Logo size={44} className="logo-lg" />
        <div className="login-pitch">
          <h2>Saiba quem fez o quê nos seus servidores de arquivos.</h2>
          <ul>
            <li>Criação, alteração, exclusão e mudança de permissões, por usuário e por pasta</li>
            <li>Relatórios por período em Excel e PDF</li>
            <li>Alerta quando um servidor para de enviar dados</li>
          </ul>
        </div>
        <p className="login-by">Um produto Tech Master</p>
      </section>
      <section className="login-panel">
        <LoginForm notice={sp.expirada ? 'Sua sessão expirou. Entre de novo.' : undefined} />
      </section>
    </main>
  );
}
