import type { Metadata } from 'next';
import Link from 'next/link';
import { currentTenant, Workspace } from '@/components/workspace';
import { ApiError, apiGet, isMsp, type CurrentUser } from '@/lib/api';
import { changeKind } from '@/lib/config';
import { roleLabel } from '@/lib/format';
import { formatDateTime } from '@/lib/filters';
import { tenantParam, withTenant } from '@/lib/workspace';

export const metadata: Metadata = { title: 'Histórico de alterações · Tech Audit' };

interface Change {
  id: string;
  created_at: string;
  hostname: string | null;
  path: string;
  kind: string;
  source: string;
  config_version: number;
  user_email: string | null;
  user_role: string | null;
  ip: string | null;
  message: string | null;
  details: { before?: unknown; after?: unknown; operation?: string; volume_override?: boolean } | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function HistoryPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const user = await apiGet<CurrentUser>('/api/auth/me');
  const msp = isMsp(user);
  const empresa = currentTenant(user, tenantParam(sp));
  const servidor = typeof sp.servidor === 'string' && UUID.test(sp.servidor) ? sp.servidor : '';
  const before = typeof sp.antes === 'string' && /^\d+$/.test(sp.antes) ? sp.antes : '';

  let page: { items: Change[]; next_before: string | null } = { items: [], next_before: null };
  let error: string | null = null;
  if (empresa) {
    const q = new URLSearchParams();
    if (msp) q.set('tenant', empresa);
    if (servidor) q.set('agent', servidor);
    if (before) q.set('before', before);
    try {
      page = await apiGet(`/api/config/changes?${q}`);
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      error = err.message;
    }
  }
  const back = withTenant('/servidores', msp ? empresa : '');
  const next = page.next_before ? withTenant('/servidores/historico', msp ? empresa : '', { servidor, antes: page.next_before }) : null;

  return (
    <>
      <Workspace user={user} tenantId={empresa} tab="servidores" needsTenant>
        <p className="crumbs">
          <Link href={back}>Servidores</Link> /
        </p>
        <h2 className="page-title">Histórico de alterações{servidor && page.items[0]?.hostname ? ` de ${page.items[0].hostname}` : ''}</h2>
        <p className="muted small">
          Registro permanente: pedidos feitos no portal e o que o agente aplicou em cada servidor, com a configuração de auditoria (SACL no Windows; auditd e Samba no Linux) antes e
          depois. Não pode ser editado nem apagado.
        </p>
        {error && <p className="error">{error}</p>}
        {!error && page.items.length === 0 && <p className="muted">Nenhuma alteração registrada.</p>}
        {page.items.length > 0 && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Quando</th>
                  <th>Servidor</th>
                  <th>Caminho</th>
                  <th>Alteração</th>
                  <th>Quem</th>
                  <th>Detalhes</th>
                </tr>
              </thead>
              <tbody>
                {page.items.map((c) => {
                  const k = changeKind(c.kind);
                  return (
                    <tr key={c.id}>
                      <td className="nowrap">{formatDateTime(c.created_at)}</td>
                      <td>{c.hostname ?? '-'}</td>
                      <td className="path">{c.path}</td>
                      <td>
                        <span className={`pill ${k.tone}`}>{k.label}</span>
                        {c.details?.volume_override && <p className="warn-text small cell-note">Liberado acima do volume</p>}
                        {c.message && <p className="small cell-note">{c.message}</p>}
                      </td>
                      <td className="small">
                        {c.source === 'agent' ? (
                          'Agente'
                        ) : (
                          <>
                            {c.user_email}
                            <br />
                            <span className="muted">
                              {c.user_role ? roleLabel(c.user_role) : ''}
                              {c.ip ? ` · ${c.ip}` : ''}
                            </span>
                          </>
                        )}
                      </td>
                      <td>
                        {c.details && (c.details.before !== undefined || c.details.after !== undefined) ? (
                          <details>
                            <summary className="small">Antes e depois</summary>
                            <pre className="code small">{JSON.stringify({ antes: c.details.before ?? null, depois: c.details.after ?? null }, null, 2)}</pre>
                          </details>
                        ) : (
                          '-'
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {next && (
          <div className="pager">
            <Link href={next}>Mais antigas</Link>
          </div>
        )}
      </Workspace>
    </>
  );
}
