import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';

// Acesso à API do Tech Audit (server/), sempre pelo servidor do Next.js: o
// navegador nunca vê o token, que fica em cookie httpOnly.

export const API_URL = (process.env.API_URL ?? 'http://localhost:3001').replace(/\/$/, '');
export const SESSION_COOKIE = 'ta_session';

export interface CurrentUser {
  id: string;
  tenant_id: string | null;
  email: string;
  name: string;
  role: string;
}

export const isMsp = (u: CurrentUser) => u.role === 'msp_admin' || u.role === 'msp_operator';

export async function sessionToken(): Promise<string | undefined> {
  return (await cookies()).get(SESSION_COOKIE)?.value;
}

// IP do usuário, para o log de acesso da API.
async function forwardedFor(): Promise<Record<string, string>> {
  const h = await headers();
  const ip = h.get('x-forwarded-for') ?? h.get('x-real-ip');
  return ip ? { 'x-forwarded-for': ip } : {};
}

export async function apiFetch(path: string, init: RequestInit & { token?: string } = {}): Promise<Response> {
  const { token, ...rest } = init;
  return fetch(API_URL + path, {
    ...rest,
    cache: 'no-store',
    headers: {
      ...(await forwardedFor()),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(rest.headers as Record<string, string> | undefined),
    },
  });
}

// GET autenticado; sem sessão válida, volta para o login.
export async function apiGet<T>(path: string): Promise<T> {
  const token = await sessionToken();
  if (!token) redirect('/login');
  const r = await apiFetch(path, { token });
  if (r.status === 401) redirect('/login?expirada=1');
  if (!r.ok) throw new ApiError(r.status, await errorMessage(r));
  return r.json() as Promise<T>;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function errorMessage(r: Response): Promise<string> {
  try {
    const body = await r.json();
    return Array.isArray(body.message) ? body.message.join('; ') : String(body.message ?? r.statusText);
  } catch {
    return r.statusText;
  }
}

export interface ActionResult {
  ok?: string;
  error?: string;
  // Valor mostrado uma única vez (senha gerada, token de instalação).
  secret?: { label: string; value: string; config?: string };
}

// Chamada de escrita para as ações do portal; nunca lança por erro da API.
export async function apiSend<T>(
  method: 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body: unknown = {},
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  const token = await sessionToken();
  if (!token) redirect('/login');
  let r: Response;
  try {
    r = await apiFetch(path, {
      method,
      token,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    return { ok: false, error: 'Servidor indisponível. Tente novamente em instantes.' };
  }
  if (r.status === 401) redirect('/login?expirada=1');
  if (!r.ok) return { ok: false, error: capitalize(await errorMessage(r)) };
  return { ok: true, data: (r.status === 204 ? null : await r.json()) as T };
}

const capitalize = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

// Telas de administração: só o administrador da Tech Master.
export async function requireAdmin(): Promise<CurrentUser> {
  const user = await apiGet<CurrentUser>('/api/auth/me');
  if (user.role !== 'msp_admin') redirect('/painel');
  return user;
}
