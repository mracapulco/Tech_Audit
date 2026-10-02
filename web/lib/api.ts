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
