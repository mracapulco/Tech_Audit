import type { Metadata } from 'next';
import Link from 'next/link';
import { ActionSelect } from '@/components/action-select';
import { currentTenant, Workspace } from '@/components/workspace';
import { ApiError, apiGet, type CurrentUser } from '@/lib/api';
import { formatInt, REPORT_TYPES } from '@/lib/dashboard';
import { withTenant } from '@/lib/workspace';
import { apiParams, formatDateTime, PERIOD_PRESETS, presetRange, screenFilters, screenQuery, type SearchParams } from '@/lib/filters';

export const metadata: Metadata = { title: 'Relatórios · Tech Audit' };

interface ReportTable {
  title: string;
  client: { label: string; value: string }[];
  notes: string[];
  columns: { key: string; label: string; kind: 'text' | 'path' | 'int' | 'datetime' }[];
  rows: Record<string, string | number | null>[];
  truncated: boolean;
}

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.trim() ?? '';

export default async function ReportsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const tipo = REPORT_TYPES.some((t) => t.key === one(sp.tipo)) ? one(sp.tipo) : 'usuarios';
  const preset = presetRange(one(sp.periodo));
  const f = { ...screenFilters(sp), ...(preset ?? {}) };
  const user = await apiGet<CurrentUser>('/api/auth/me');
  const current = REPORT_TYPES.find((t) => t.key === tipo)!;

  let t: ReportTable | null = null;
  let error: string | null = null;
  try {
    t = await apiGet<ReportTable>(`/api/reports/${tipo}?${apiParams(f)}`);
  } catch (err) {
    if (!(err instanceof ApiError)) throw err;
    error = err.message;
  }

  const download = (formato: string) => `/relatorios/exportar?${screenQuery(f, { tipo, formato })}`;
  const tenantId = currentTenant(user, f.cliente);
  // Leva os filtros (sem o período) para o agendamento por e-mail.
  const schedule = withTenant('/alertas', f.cliente, { agendar: tipo, usuario: f.usuario, caminho: f.caminho, acao: f.acao });

  return (
    <>
      <Workspace user={user} tenantId={tenantId} tab="relatorios">
        <h2 className="page-title">Relatórios</h2>

        <nav className="tabs" aria-label="Tipo de relatório">
          {REPORT_TYPES.map((r) => (
            <Link key={r.key} href={`/relatorios?${screenQuery(f, { tipo: r.key })}`} className={r.key === tipo ? 'active' : undefined} aria-current={r.key === tipo ? 'page' : undefined}>
              {r.label}
            </Link>
          ))}
        </nav>
        <p className="muted small">{current.hint}</p>

        <form method="get" className="card filters">
          <input type="hidden" name="tipo" value={tipo} />
          {f.cliente && <input type="hidden" name="cliente" value={f.cliente} />}
          <label>
            Usuário
            <input name="usuario" defaultValue={f.usuario} placeholder="joao.silva, DOMINIO\joao ou SID" />
          </label>
          <label className="wide">
            Caminho (inclui subpastas)
            <input name="caminho" defaultValue={f.caminho} placeholder="D:\Dados\Financeiro" />
          </label>
          <ActionSelect value={f.acao} />
          <label>
            De
            <input type="datetime-local" name="de" defaultValue={f.de} required />
          </label>
          <label>
            Até
            <input type="datetime-local" name="ate" defaultValue={f.ate} required />
          </label>
          <div className="buttons">
            <button type="submit">Gerar relatório</button>
          </div>
          <div className="presets wide">
            <span className="muted">Período rápido:</span>
            {PERIOD_PRESETS.map((p) => (
              <Link key={p.key} href={`/relatorios?${screenQuery({ ...f, de: '', ate: '' }, { tipo, periodo: p.key })}`}>
                {p.label}
              </Link>
            ))}
          </div>
        </form>

        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}

        {t && (
          <section className="section">
            <div className="title-row">
              <h2>{t.title}</h2>
              <div className="form-actions">
                <a className="button" href={download('xlsx')} download>
                  Baixar Excel
                </a>
                <a className="button secondary" href={download('pdf')} download>
                  Baixar PDF
                </a>
                {tenantId && (
                  <Link className="small" href={schedule}>
                    Agendar por e-mail
                  </Link>
                )}
              </div>
            </div>
            <p className="muted small">
              {t.client
                .filter((f) => !f.label.startsWith('Gerado'))
                .map((f) => `${f.label}: ${f.value}`)
                .join(' · ')}
              {t.truncated && (
                <>
                  {' '}
                  · <span className="warn-text">Mostrando só as primeiras {formatInt(t.rows.length)} linhas.</span> O Excel traz o resultado
                  completo (até o limite da exportação).
                </>
              )}
            </p>
            {t.rows.length === 0 ? (
              <p className="card empty">Nenhum registro encontrado com esses filtros.</p>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      {t.columns.map((c) => (
                        <th key={c.key} className={c.kind === 'int' ? 'num' : undefined}>
                          {c.label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {t.rows.map((r, i) => (
                      <tr key={i}>
                        {t.columns.map((c) => (
                          <td key={c.key} className={c.kind === 'int' ? 'num' : c.kind === 'path' ? 'path' : c.kind === 'datetime' ? 'nowrap' : undefined}>
                            {cell(c.kind, r[c.key])}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        )}
      </Workspace>
    </>
  );
}

function cell(kind: string, v: string | number | null | undefined) {
  if (v === null || v === undefined || v === '') return '-';
  if (kind === 'int') return formatInt(v);
  if (kind === 'datetime') return formatDateTime(String(v));
  return String(v);
}
