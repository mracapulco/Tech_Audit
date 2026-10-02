'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { apiFetch, errorMessage, SESSION_COOKIE } from '@/lib/api';

export type LoginState = { error?: string; email?: string } | undefined;

export async function login(_: LoginState, form: FormData): Promise<LoginState> {
  const email = String(form.get('email') ?? '').trim();
  const password = String(form.get('password') ?? '');
  if (!email || !password) return { error: 'Informe e-mail e senha.', email };

  let r: Response;
  try {
    r = await apiFetch('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
  } catch {
    return { error: 'Servidor indisponível. Tente novamente em instantes.', email };
  }
  if (r.status === 401) return { error: 'E-mail ou senha incorretos.', email };
  if (r.status === 429) return { error: 'Muitas tentativas. Aguarde 15 minutos e tente de novo.', email };
  if (!r.ok) return { error: await errorMessage(r), email };

  const { token, expires_at } = (await r.json()) as { token: string; expires_at: string };
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    // Em produção o portal roda atrás de HTTPS; COOKIE_SECURE=false só para testes em HTTP.
    secure: process.env.NODE_ENV === 'production' && process.env.COOKIE_SECURE !== 'false',
    path: '/',
    expires: new Date(expires_at),
  });
  redirect('/painel');
}

export async function logout(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) {
    await apiFetch('/api/auth/logout', { method: 'POST', token }).catch(() => undefined);
  }
  jar.delete(SESSION_COOKIE);
  redirect('/login');
}
