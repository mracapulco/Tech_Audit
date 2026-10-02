import type { Metadata } from 'next';
import Link from 'next/link';
import { ApiError, apiGet, isMsp, type CurrentUser } from '@/lib/api';
import { ACTION_LABELS, actionLabel, apiParams, formatDateTime, screenFilters, screenQuery, type SearchParams } from '@/lib/filters';
import { TopBar } from '@/components/top-bar';

export const metadata: Metadata = { title: 'Eventos · Tech Audit' };

interface EventRow {
  time: string;
  tenant_id: string;
  tenant_name: string;
  agent_id: string;
  server: string;
  record_id: string;
  event_id: number;
  path: string | null;
  user_domain: string | null;
  user_name: string | null;
  actions: string[];
  success: boolean;
  source_ip: string | null;
  process_name: string | null;
}

const PAGE_SIZE = '50';

export default async function EventsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const f = screenFilters(sp);
  const cursor = typeof sp.cursor === 'string' ? sp.cursor : '';
  const user = await apiGet<CurrentUser>('/api/auth/me');
  const msp = isMsp(user);
  const tenants = msp ? await apiGet<{ id: string; name: string }[]>('/api/tenants') : [];

  let page: { items: EventRow[]; next_cursor: string | null } = { items: [], next_cursor: null };
  let error: string | null = null;
  try {
    page = await apiGet(`/api/events?${apiParams(f, { cursor, limit: PAGE_SIZE })}`);
  } catch (err) {
    if (!(err instanceof ApiError)) throw err;
    error = err.message;
  }

  return (
    <>
      <TopBar user={user} active="eventos" />

      <main className="page">
        <h1>Pesquisa de eventos</h1>

        <form method="get" className="card filters">
          {msp && (
            <label>
              Cliente
              <select name="cliente" defaultValue={f.cliente}>
                <option value="">Todos os clientes</option>
                {tenants.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label>
            Usuário
            <input name="usuario" defaultValue={f.usuario} placeholder="joao.silva, DOMINIO\joao ou SID" />
          </label>
          <label className="wide">
            Caminho (inclui subpastas)
            <input name="caminho" defaultValue={f.caminho} placeholder="D:\Dados\Financeiro" />
          </label>
          <label>
            Ação
            <select name="acao" defaultValue={f.acao}>
              <option value="">Todas</option>
              {Object.entries(ACTION_LABELS).map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </label>
          <label>
            De
            <input type="datetime-local" name="de" defaultValue={f.de} required />
          </label>
          <label>
            Até
            <input type="datetime-local" name="ate" defaultValue={f.ate} required />
          </label>
          <div className="buttons">
            <button type="submit">Pesquisar</button>
            <a className="button secondary" href={`/eventos/exportar?${screenQuery(f)}`} download>
              Exportar CSV
            </a>
          </div>
        </form>

        <p className="muted small">Horários de Brasília. Os filtros de usuário e caminho não diferenciam maiúsculas.</p>

        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}

        {!error && page.items.length === 0 && <p className="card empty">Nenhum evento encontrado com esses filtros.</p>}

        {page.items.length > 0 && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Data/hora</th>
                  {msp && <th>Cliente</th>}
                  <th>Servidor</th>
                  <th>Usuário</th>
                  <th>Ação</th>
                  <th>Caminho</th>
                  <th>Resultado</th>
                  <th>IP de origem</th>
                </tr>
              </thead>
              <tbody>
                {page.items.map((e) => (
                  <tr key={`${e.agent_id}-${e.record_id}-${e.time}`}>
                    <td className="nowrap">{formatDateTime(e.time)}</td>
                    {msp && <td>{e.tenant_name}</td>}
                    <td>{e.server}</td>
                    <td className="nowrap">{e.user_name ? `${e.user_domain ? e.user_domain + '\\' : ''}${e.user_name}` : '-'}</td>
                    <td>{e.actions.map(actionLabel).join(', ') || '-'}</td>
                    <td className="path" title={e.process_name ? `Processo: ${e.process_name}` : undefined}>
                      {e.path ?? '-'}
                    </td>
                    <td className={e.success ? 'ok' : 'fail'}>{e.success ? 'Sucesso' : 'Falha'}</td>
                    <td>{e.source_ip ?? '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <nav className="pager">
          {cursor && <Link href={`/eventos?${screenQuery(f)}`}>« Primeira página</Link>}
          {page.next_cursor && <Link href={`/eventos?${screenQuery(f, { cursor: page.next_cursor })}`}>Próxima página »</Link>}
        </nav>
      </main>
    </>
  );
}
