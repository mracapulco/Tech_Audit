import type { Metadata } from 'next';
import Link from 'next/link';
import { ActionSelect } from '@/components/action-select';
import { TopBar } from '@/components/top-bar';
import { ApiError, apiGet, isMsp, type CurrentUser } from '@/lib/api';
import { formatInt, REPORT_TYPES } from '@/lib/dashboard';
import { apiParams, formatDateTime, PERIOD_PRESETS, presetRange, screenFilters, screenQuery, type SearchParams } from '@/lib/filters';

export const metadata: Metadata = { title: 'Relatórios · Tech Audit' };

interface ReportTable {
  title: string;
  info: string[];
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
  const msp = isMsp(user);
  const tenants = msp ? await apiGet<{ id: string; name: string }[]>('/api/tenants') : [];
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

  return (
    <>
      <TopBar user={user} active="relatorios" />
      <main className="page">
        <h1>Relatórios</h1>

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
          {msp && (
            <label>
              Empresa
              <select name="cliente" defaultValue={f.cliente}>
                <option value="">Todas as empresas</option>
                {tenants.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
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
              </div>
            </div>
            <p className="muted small">
              {t.info.filter((l) => !l.startsWith('Gerado em')).join(' · ')}
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
      </main>
    </>
  );
}

function cell(kind: string, v: string | number | null | undefined) {
  if (v === null || v === undefined || v === '') return '-';
  if (kind === 'int') return formatInt(v);
  if (kind === 'datetime') return formatDateTime(String(v));
  return String(v);
}
