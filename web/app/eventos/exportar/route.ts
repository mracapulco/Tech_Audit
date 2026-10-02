import { NextResponse, type NextRequest } from 'next/server';
import { apiFetch, errorMessage, sessionToken } from '@/lib/api';
import { apiParams, screenFilters } from '@/lib/filters';

// Repassa a exportação CSV da API para o navegador, sem carregar tudo em memória.
export async function GET(req: NextRequest) {
  const token = await sessionToken();
  if (!token) return NextResponse.redirect(new URL('/login', req.url));
  const f = screenFilters(Object.fromEntries(req.nextUrl.searchParams));
  const r = await apiFetch(`/api/events/export.csv?${apiParams(f)}`, { token });
  if (r.status === 401) return NextResponse.redirect(new URL('/login?expirada=1', req.url));
  if (!r.ok || !r.body) {
    return new NextResponse(`Não foi possível exportar: ${await errorMessage(r)}`, {
      status: r.status,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }
  return new NextResponse(r.body, {
    headers: {
      'content-type': r.headers.get('content-type') ?? 'text/csv; charset=utf-8',
      'content-disposition': r.headers.get('content-disposition') ?? 'attachment; filename="eventos.csv"',
      'cache-control': 'no-store',
    },
  });
}
