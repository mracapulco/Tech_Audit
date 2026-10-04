import type { Metadata } from 'next';
import { ActionForm } from '@/components/action-form';
import { TopBar } from '@/components/top-bar';
import { ApiError, apiGet, requireAdmin } from '@/lib/api';
import { formatDate, formatDateTimeShort, formatLastDay } from '@/lib/format';
import { startPurge } from './actions';
import { AutoRefresh } from './auto-refresh';
import { PurgeFilters, type PurgeOption, type PurgeQuery } from './purge-filters';

export const metadata: Metadata = { title: 'Limpeza de eventos · Tech Audit' };

interface Preview {
  tenant: { id: string; name: string };
  agent: { id: string; hostname: string } | null;
  mode: string;
  retention_days: number | null;
  from: string | null;
  to: string;
  count: string;
  first: string | null;
  last: string | null;
}

interface Purge {
  id: string;
  tenant_name: string | null;
  hostname: string | null;
  mode: string;
  retention_days: number | null;
  from: string | null;
  to: string;
  user_name: string | null;
  status: string;
  expected_count: string;
  deleted_count: string;
  error: string | null;
  created_at: string;
  finished_at: string | null;
}

const STATUS: Record<string, { label: string; tone: string }> = {
  running: { label: 'Em andamento', tone: 'warn' },
  done: { label: 'Concluída', tone: 'ok' },
  failed: { label: 'Falhou', tone: 'bad' },
  interrupted: { label: 'Interrompida', tone: 'bad' },
};

const num = (v: string) => Number(v).toLocaleString('pt-BR');
const period = (from: string | null, to: string) => (from ? `de ${formatDate(from)} a ${formatLastDay(to)}` : `até ${formatLastDay(to)}`);
const one = (v: string | string[] | undefined) => (typeof v === 'string' ? v : undefined);

export default async function PurgePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requireAdmin();
  const sp = await searchParams;
  const q: PurgeQuery = { tenant_id: one(sp.tenant_id), agent_id: one(sp.agent_id), mode: one(sp.mode), from: one(sp.from), to: one(sp.to) };
  const [tenants, purges] = await Promise.all([apiGet<PurgeOption[]>('/api/admin/purges/options'), apiGet<Purge[]>('/api/admin/purges')]);

  let preview: Preview | null = null;
  let previewError: string | null = null;
  if (q.tenant_id) {
    const params = new URLSearchParams(Object.entries(q).filter((e): e is [string, string] => !!e[1]));
    try {
      preview = await apiGet<Preview>(`/api/admin/purges/preview?${params}`);
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      previewError = err.message;
    }
  }
  const running = purges.some((p) => p.status === 'running');

  return (
    <>
      <TopBar user={user} active="limpeza" />
      <main className="page">
        <h1>Limpeza de eventos</h1>
        <p className="muted small">
          Apaga do banco os eventos de uma empresa, de todos os servidores ou de um só. Primeiro o portal mostra quantos eventos serão
          apagados; nada é removido antes da confirmação. A exclusão não pode ser desfeita e fica registrada no histórico abaixo.
        </p>
        {one(sp.iniciada) && (
          <p className="notice" role="status">
            Limpeza iniciada. O andamento aparece no histórico abaixo.
          </p>
        )}

        <PurgeFilters key={JSON.stringify(q)} tenants={tenants} initial={q} />

        {previewError && (
          <p className="error" role="alert">
            {previewError[0].toUpperCase() + previewError.slice(1)}
          </p>
        )}
        {preview && (
          <section className="card section">
            <h2>Conferência</h2>
            <p>
              <strong>{num(preview.count)}</strong> evento(s) de <strong>{preview.tenant.name}</strong>
              {preview.agent ? ` no servidor ${preview.agent.hostname}` : ' em todos os servidores'}, {period(preview.from, preview.to)}
              {preview.mode === 'retention' && ` (retenção de ${preview.retention_days} dias)`}.
            </p>
            {preview.count === '0' ? (
              <p className="muted small">Nada para apagar com esses filtros.</p>
            ) : (
              <>
                <p className="muted small">
                  O mais antigo é de {formatDateTimeShort(preview.first)} e o mais recente de {formatDateTimeShort(preview.last)}.
                </p>
                <ActionForm
                  action={startPurge}
                  submit={`Apagar ${num(preview.count)} evento(s)`}
                  confirm={`Apagar ${num(preview.count)} evento(s) de ${preview.tenant.name}? Isso não pode ser desfeito.`}
                >
                  {(['tenant_id', 'agent_id', 'mode', 'from', 'to'] as const).map((k) => (
                    <input key={k} type="hidden" name={k} value={q[k] ?? ''} />
                  ))}
                </ActionForm>
              </>
            )}
          </section>
        )}

        <section className="section">
          <h2>Histórico</h2>
          {running && <AutoRefresh />}
          {purges.length === 0 ? (
            <p className="card empty">Nenhuma limpeza feita ainda.</p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Pedida em</th>
                    <th>Empresa</th>
                    <th>Servidor</th>
                    <th>Período</th>
                    <th>Situação</th>
                    <th>Apagados</th>
                    <th>Por</th>
                  </tr>
                </thead>
                <tbody>
                  {purges.map((p) => {
                    const s = STATUS[p.status] ?? { label: p.status, tone: 'neutral' };
                    return (
                      <tr key={p.id}>
                        <td className="nowrap">{formatDateTimeShort(p.created_at)}</td>
                        <td>{p.tenant_name}</td>
                        <td>{p.hostname ?? 'Todos'}</td>
                        <td className="nowrap">
                          {period(p.from, p.to)}
                          {p.mode === 'retention' && <span className="muted small"> · retenção {p.retention_days} dias</span>}
                        </td>
                        <td>
                          <span className={`pill ${s.tone}`} title={p.error ?? undefined}>
                            {s.label}
                          </span>
                          {p.error && <p className="muted small cell-note">{p.error}</p>}
                        </td>
                        <td className="nowrap">
                          {num(p.deleted_count)} de {num(p.expected_count)}
                        </td>
                        <td>{p.user_name ?? '-'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </main>
    </>
  );
}
