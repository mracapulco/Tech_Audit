'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { apiFetch, errorMessage, SESSION_COOKIE } from '@/lib/api';
import { otpauthUrl, qrDataUrl } from '@/lib/mfa';

// Etapas do login: e-mail e senha; depois o código do autenticador ("code")
// ou o cadastro do autenticador, obrigatório para a equipe Tech Master ("setup").
export type LoginState =
  | {
      error?: string;
      email?: string;
      step?: 'code' | 'setup';
      challenge?: string;
      secret?: string;
      qr?: string;
    }
  | undefined;

const UNAVAILABLE = 'Servidor indisponível. Tente novamente em instantes.';

export async function login(_: LoginState, form: FormData): Promise<LoginState> {
  if (form.get('challenge')) return loginCode(form);
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
    return { error: UNAVAILABLE, email };
  }
  if (r.status === 401) return { error: 'E-mail ou senha incorretos.', email };
  if (r.status === 429) return { error: 'Muitas tentativas. Aguarde 15 minutos e tente de novo.', email };
  if (!r.ok) return { error: await errorMessage(r), email };

  const body = (await r.json()) as { token?: string; expires_at: string; mfa?: 'verify' | 'setup'; challenge?: string; secret?: string };
  if (body.mfa === 'verify') return { step: 'code', challenge: body.challenge, email };
  if (body.mfa === 'setup') return setupState(email, body.challenge!, body.secret!);
  await startSession(body.token!, body.expires_at);
  redirect('/painel');
}

async function setupState(email: string, challenge: string, secret: string, error?: string): Promise<LoginState> {
  return { step: 'setup', email, challenge, secret, qr: await qrDataUrl(otpauthUrl(secret, email)), error };
}

async function loginCode(form: FormData): Promise<LoginState> {
  const email = String(form.get('email') ?? '');
  const challenge = String(form.get('challenge') ?? '');
  const secret = String(form.get('secret') ?? '');
  const code = String(form.get('code') ?? '').replace(/\s/g, '');
  // Mesma tela de novo, com a mensagem de erro.
  const again = (error: string) => (secret ? setupState(email, challenge, secret, error) : { step: 'code' as const, email, challenge, error });
  if (!/^\d{6}$/.test(code)) return again('Digite os 6 números que aparecem no aplicativo.');

  let r: Response;
  try {
    r = await apiFetch('/api/auth/login/mfa', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ challenge, code }),
    });
  } catch {
    return again(UNAVAILABLE);
  }
  if (r.status === 401) {
    const msg = await errorMessage(r);
    if (msg === 'código incorreto') return again('Código incorreto. Confira se a hora do celular está certa e use o código atual.');
    return { error: 'O tempo para digitar o código acabou. Entre de novo.', email };
  }
  if (!r.ok) return again(await errorMessage(r));
  const { token, expires_at } = (await r.json()) as { token: string; expires_at: string };
  await startSession(token, expires_at);
  redirect('/painel');
}

async function startSession(token: string, expiresAt: string) {
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    // Em produção o portal roda atrás de HTTPS; COOKIE_SECURE=false só para testes em HTTP.
    secure: process.env.NODE_ENV === 'production' && process.env.COOKIE_SECURE !== 'false',
    path: '/',
    expires: new Date(expiresAt),
  });
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
