import { NextResponse, type NextRequest } from 'next/server';
import { apiFetch, errorMessage, sessionToken } from '@/lib/api';
import { permApiQuery, permFilters } from '@/lib/permissions';
import { tenantParam } from '@/lib/workspace';

// Repassa o Excel ou PDF do inventário gerado pela API para o navegador.
export async function GET(req: NextRequest) {
  const token = await sessionToken();
  if (!token) return NextResponse.redirect(new URL('/login', req.url));
  const sp = Object.fromEntries(req.nextUrl.searchParams);
  const formato = sp.formato ?? '';
  if (!['xlsx', 'pdf'].includes(formato)) {
    return new NextResponse('Formato inválido.', { status: 400, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  }
  const r = await apiFetch(`/api/permissions/export?${permApiQuery(permFilters(sp), tenantParam(sp), { format: formato })}`, { token });
  if (r.status === 401) return NextResponse.redirect(new URL('/login?expirada=1', req.url));
  if (!r.ok || !r.body) {
    return new NextResponse(`Não foi possível gerar o arquivo: ${await errorMessage(r)}`, {
      status: r.status,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }
  return new NextResponse(r.body, {
    headers: {
      'content-type': r.headers.get('content-type') ?? 'application/octet-stream',
      'content-disposition': r.headers.get('content-disposition') ?? `attachment; filename="permissoes.${formato}"`,
      'cache-control': 'no-store',
    },
  });
}
