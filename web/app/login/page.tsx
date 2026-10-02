import type { Metadata } from 'next';
import { LoginForm } from './login-form';

export const metadata: Metadata = { title: 'Entrar · Tech Audit' };

export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  return (
    <main className="center">
      <LoginForm notice={sp.expirada ? 'Sua sessão expirou. Entre de novo.' : undefined} />
    </main>
  );
}
