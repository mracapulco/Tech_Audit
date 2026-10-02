import { NextResponse, type NextRequest } from 'next/server';
import { apiFetch, errorMessage, sessionToken } from '@/lib/api';
import { REPORT_TYPES } from '@/lib/dashboard';
import { apiParams, screenFilters } from '@/lib/filters';

// Repassa o Excel ou PDF gerado pela API para o navegador.
export async function GET(req: NextRequest) {
  const token = await sessionToken();
  if (!token) return NextResponse.redirect(new URL('/login', req.url));
  const sp = req.nextUrl.searchParams;
  const tipo = sp.get('tipo') ?? '';
  const formato = sp.get('formato') ?? '';
  if (!REPORT_TYPES.some((t) => t.key === tipo) || !['xlsx', 'pdf'].includes(formato)) {
    return new NextResponse('Relatório ou formato inválido.', { status: 400, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  }
  const f = screenFilters(Object.fromEntries(sp));
  const r = await apiFetch(`/api/reports/${tipo}?${apiParams(f, { format: formato })}`, { token });
  if (r.status === 401) return NextResponse.redirect(new URL('/login?expirada=1', req.url));
  if (!r.ok || !r.body) {
    return new NextResponse(`Não foi possível gerar o relatório: ${await errorMessage(r)}`, {
      status: r.status,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }
  return new NextResponse(r.body, {
    headers: {
      'content-type': r.headers.get('content-type') ?? 'application/octet-stream',
      'content-disposition': r.headers.get('content-disposition') ?? `attachment; filename="relatorio.${formato}"`,
      'cache-control': 'no-store',
    },
  });
}
