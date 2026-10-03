import { NextResponse, type NextRequest } from 'next/server';
import { apiFetch, errorMessage, sessionToken } from '@/lib/api';

// Repassa o instalador do agente (MSI ou pacote Linux) da API para o navegador (só com login).
export async function GET(req: NextRequest) {
  const token = await sessionToken();
  if (!token) return NextResponse.redirect(new URL('/login', req.url));
  // windows (MSI, padrão), deb ou rpm.
  const kind = req.nextUrl.searchParams.get('tipo') ?? 'windows';
  if (!['windows', 'deb', 'rpm'].includes(kind)) return new NextResponse('Tipo de instalador inválido', { status: 400 });
  const r = await apiFetch(`/api/agent/installer/download?kind=${kind}`, { token });
  if (r.status === 401) return NextResponse.redirect(new URL('/login?expirada=1', req.url));
  if (!r.ok || !r.body) {
    return new NextResponse(`Não foi possível baixar o instalador: ${await errorMessage(r)}`, {
      status: r.status,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }
  const headers: Record<string, string> = {
    'content-type': r.headers.get('content-type') ?? 'application/octet-stream',
    'content-disposition': r.headers.get('content-disposition') ?? 'attachment; filename="TechAuditAgent.msi"',
    'cache-control': 'no-store',
  };
  const length = r.headers.get('content-length');
  if (length) headers['content-length'] = length;
  return new NextResponse(r.body, { headers });
}
