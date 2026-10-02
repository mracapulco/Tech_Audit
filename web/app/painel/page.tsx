import type { Metadata } from 'next';
import Link from 'next/link';
import { BarList } from '@/components/bar-list';
import { TimelineChart, type TimelinePoint } from '@/components/timeline-chart';
import { TopBar } from '@/components/top-bar';
import { ApiError, apiGet, isMsp, type CurrentUser } from '@/lib/api';
import { ago, formatInt, health, userText } from '@/lib/dashboard';
import { actionLabel, eventActionText, newPathText, formatDateTime, localToIso, PERIOD_PRESETS, presetRange, screenQuery, type SearchParams } from '@/lib/filters';
import { formatBytes, formatLastDay, licenseStatus } from '@/lib/format';

export const metadata: Metadata = { title: 'Painel · Tech Audit' };

interface Company {
  id: string;
  name: string;
  license: { status: string; max_agents: number; max_volume_bytes: string; valid_until: string | null; active_agents: number };
  agents_attention: number;
  events: number;
}

interface Dashboard {
  tenant: { id: string; name: string } | null;
  period: { from: string; to: string; bucket: 'hour' | 'day' | 'month' };
  totals: { total: number; failures: number; users: number; paths: number; sensitive: number };
  timeline: TimelinePoint[];
  actions: { action: string; label: string; total: number }[];
  top_users: { tenant_id: string; tenant_name: string; user_domain: string | null; user_name: string | null; user_sid: string | null; total: number }[];
  top_folders: { tenant_id: string; tenant_name: string; server: string; folder: string; total: number; users: number }[];
  recent_sensitive: {
    time: string;
    tenant_name: string;
    agent_id: string;
    record_id: string;
    server: string;
    path: string | null;
    user_domain: string | null;
    user_name: string | null;
    actions: string[];
    action: string | null;
    new_path: string | null;
    item_type: string | null;
    count: number;
    success: boolean;
  }[];
  sensitive_actions: string[];
  agents: {
    id: string;
    tenant_id: string;
    tenant_name: string;
    hostname: string;
    agent_version: string | null;
    last_seen_at: string | null;
    heartbeat: boolean;
    buffer_events: number | null;
    health: string;
    events: number;
  }[];
  companies: Company[];
}

const BUCKET_TITLE = { hour: 'Eventos por hora', day: 'Eventos por dia', month: 'Eventos por mês' };
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.trim() ?? '';

export default async function DashboardPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const user = await apiGet<CurrentUser>('/api/auth/me');
  const msp = isMsp(user);
  const tenants = msp ? await apiGet<{ id: string; name: string }[]>('/api/tenants') : [];
  const cliente = msp ? one(sp.cliente) : '';
  const periodo = PERIOD_PRESETS.some((p) => p.key === one(sp.periodo)) ? one(sp.periodo) : '7d';
  const range = presetRange(periodo)!;

  const params = new URLSearchParams({ from: localToIso(range.de)!, to: localToIso(range.ate)! });
  if (cliente) params.set('tenant', cliente);
  let d: Dashboard | null = null;
  let error: string | null = null;
  try {
    d = await apiGet<Dashboard>(`/api/dashboard?${params}`);
  } catch (err) {
    if (!(err instanceof ApiError)) throw err;
    error = err.message;
  }

  // Links para a pesquisa e os relatórios com o mesmo cliente e período.
  const filters = { cliente, usuario: '', caminho: '', acao: '', de: range.de, ate: range.ate };
  const eventsLink = (extra: Record<string, string> = {}) => `/eventos?${screenQuery({ ...filters, ...extra })}`;
  const reportLink = (tipo: string, extra: Record<string, string> = {}) => `/relatorios?${screenQuery({ ...filters, ...extra }, { tipo })}`;
  const periodLink = (key: string) => `/painel?${new URLSearchParams({ ...(cliente ? { cliente } : {}), periodo: key })}`;
  const showTenant = msp && !cliente;
  const company = d && d.companies.length === 1 && d.tenant ? d.companies[0] : null;
  const agents = d ? (showTenant ? d.agents.filter((a) => a.health === 'stale' || a.health === 'never') : d.agents) : [];

  return (
    <>
      <TopBar user={user} active="painel" />
      <main className="page">
        <div className="title-row">
          <h1>{d?.tenant?.name ?? (msp ? 'Todas as empresas' : 'Painel')}</h1>
          <nav className="segmented" aria-label="Período">
            {PERIOD_PRESETS.map((p) => (
              <Link key={p.key} href={periodLink(p.key)} className={p.key === periodo ? 'active' : undefined} aria-current={p.key === periodo ? 'true' : undefined}>
                {p.label}
              </Link>
            ))}
          </nav>
        </div>

        {msp && (
          <form method="get" className="filter-row">
            <input type="hidden" name="periodo" value={periodo} />
            <label>
              Empresa
              <select name="cliente" defaultValue={cliente}>
                <option value="">Todas as empresas</option>
                {tenants.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </label>
            <button type="submit">Ver painel</button>
          </form>
        )}

        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}

        {d && (
          <>
            <section className="summary">
              <Stat label="Eventos" value={d.totals.total} href={eventsLink()} />
              <Stat label="Usuários ativos" value={d.totals.users} href={reportLink('usuarios')} />
              <Stat label="Arquivos e pastas tocados" value={d.totals.paths} href={reportLink('pastas')} />
              <Stat label="Exclusões e permissões" value={d.totals.sensitive} warn={d.totals.sensitive > 0} />
              <Stat label="Acessos negados" value={d.totals.failures} warn={d.totals.failures > 0} />
            </section>

            <section className="card section">
              <div className="title-row">
                <h2>{BUCKET_TITLE[d.period.bucket]}</h2>
                <Link href={reportLink('periodo')} className="small">
                  Relatório por período
                </Link>
              </div>
              {d.totals.total === 0 ? (
                <p className="muted small">Nenhum evento neste período.</p>
              ) : (
                <TimelineChart points={d.timeline} bucket={d.period.bucket} title={`${BUCKET_TITLE[d.period.bucket]}, ${formatInt(d.totals.total)} no total`} />
              )}
            </section>

            <div className="grid-3">
              <section className="card section">
                <h2>Ações</h2>
                <BarList
                  empty="Nenhuma ação registrada."
                  items={d.actions.map((a) => ({ key: a.action, label: actionLabel(a.action), value: a.total, href: eventsLink({ acao: a.action }) }))}
                />
              </section>
              <section className="card section">
                <div className="title-row">
                  <h2>Usuários mais ativos</h2>
                  <Link href={reportLink('usuarios')} className="small">
                    Ver todos
                  </Link>
                </div>
                <BarList
                  empty="Nenhum usuário no período."
                  items={d.top_users.map((u) => ({
                    key: `${u.tenant_id}-${u.user_sid ?? u.user_name}`,
                    label: userText(u),
                    value: u.total,
                    sub: showTenant ? u.tenant_name : undefined,
                    href: u.user_sid || u.user_name ? eventsLink({ usuario: u.user_sid ?? userText(u), cliente: u.tenant_id }) : undefined,
                  }))}
                />
              </section>
              <section className="card section">
                <div className="title-row">
                  <h2>Pastas mais movimentadas</h2>
                  <Link href={reportLink('pastas')} className="small">
                    Ver todas
                  </Link>
                </div>
                <BarList
                  empty="Nenhuma pasta no período."
                  items={d.top_folders.map((f) => ({
                    key: `${f.tenant_id}-${f.server}-${f.folder}`,
                    label: f.folder || '(raiz)',
                    value: f.total,
                    mono: true,
                    sub: `${showTenant ? f.tenant_name + ' · ' : ''}${f.server} · ${formatInt(f.users)} ${f.users === 1 ? 'usuário' : 'usuários'}`,
                    href: eventsLink({ caminho: f.folder, cliente: f.tenant_id }),
                  }))}
                />
              </section>
            </div>

            <section className="section">
              <h2>Exclusões e mudanças de permissão recentes</h2>
              {d.recent_sensitive.length === 0 ? (
                <p className="card empty">Nenhuma exclusão ou mudança de permissão neste período.</p>
              ) : (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Data/hora</th>
                        {showTenant && <th>Empresa</th>}
                        <th>Servidor</th>
                        <th>Usuário</th>
                        <th>Ação</th>
                        <th>Caminho</th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.recent_sensitive.map((e) => (
                        <tr key={`${e.agent_id}-${e.record_id}-${e.time}`}>
                          <td className="nowrap">{formatDateTime(e.time)}</td>
                          {showTenant && <td>{e.tenant_name}</td>}
                          <td>{e.server}</td>
                          <td className="nowrap">{userText(e)}</td>
                          <td>{eventActionText(e)}</td>
                          <td className="path">
                            {e.path ?? '-'}
                            {newPathText(e) && <span className="new-path">→ {newPathText(e)}</span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            {company && <LicenseCard c={company} />}

            {showTenant && (
              <section className="section">
                <h2>Empresas</h2>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Empresa</th>
                        <th>Licença</th>
                        <th>Vigente até</th>
                        <th>Servidores</th>
                        <th>Agentes parados</th>
                        <th>Eventos no período</th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.companies.map((c) => {
                        const s = licenseStatus(c.license.status);
                        return (
                          <tr key={c.id}>
                            <td>
                              <Link href={`/painel?${new URLSearchParams({ cliente: c.id, periodo })}`}>{c.name}</Link>
                            </td>
                            <td>
                              <span className={`pill ${s.tone}`}>{s.label}</span>
                            </td>
                            <td className="nowrap">{formatLastDay(c.license.valid_until)}</td>
                            <td>
                              {c.license.active_agents} de {c.license.max_agents}
                            </td>
                            <td className={c.agents_attention ? 'warn-text' : undefined}>{c.agents_attention}</td>
                            <td>{formatInt(c.events)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </section>
            )}

            <section className="section">
              <h2>{showTenant ? 'Agentes que precisam de atenção' : 'Servidores monitorados'}</h2>
              <p className="muted small">
                O agente atual manda um sinal de vida a cada minuto: &quot;Sem sinal recente&quot; aparece depois de 5 minutos sem contato e
                &quot;Parado&quot; depois de 1 hora. Agentes antigos (sem sinal de vida) só falam com o servidor quando há eventos; para eles os
                limites são 1 hora e 1 dia.
              </p>
              {agents.length === 0 ? (
                <p className="card empty">{showTenant ? 'Todos os agentes estão enviando dados.' : 'Nenhum agente instalado ainda.'}</p>
              ) : (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Servidor</th>
                        {showTenant && <th>Empresa</th>}
                        <th>Situação</th>
                        <th>Último contato</th>
                        <th>Aguardando envio</th>
                        <th>Versão do agente</th>
                        <th>Eventos no período</th>
                      </tr>
                    </thead>
                    <tbody>
                      {agents.map((a) => {
                        const h = health(a.health);
                        return (
                          <tr key={a.id} className={a.health === 'disabled' ? 'dim' : undefined}>
                            <td>{a.hostname}</td>
                            {showTenant && <td>{a.tenant_name}</td>}
                            <td>
                              <span className={`pill ${h.tone}`}>{h.label}</span>
                            </td>
                            <td className="nowrap" title={a.last_seen_at ? formatDateTime(a.last_seen_at) : undefined}>
                              {ago(a.last_seen_at)}
                            </td>
                            <td title="Eventos guardados no servidor do cliente que ainda não chegaram aqui">
                              {a.heartbeat ? formatInt(a.buffer_events ?? 0) : '-'}
                            </td>
                            <td>{a.agent_version ?? '-'}</td>
                            <td>{formatInt(a.events)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </>
        )}
      </main>
    </>
  );
}

function Stat({ label, value, href, warn }: { label: string; value: number; href?: string; warn?: boolean }) {
  const body = (
    <>
      <span className="muted small">{label}</span>
      <strong className={warn ? 'warn-text' : undefined}>{formatInt(value)}</strong>
    </>
  );
  return href ? (
    <Link href={href} className="card stat stat-link">
      {body}
    </Link>
  ) : (
    <div className="card stat">{body}</div>
  );
}

function LicenseCard({ c }: { c: Company }) {
  const s = licenseStatus(c.license.status);
  const used = c.license.max_agents ? Math.min(c.license.active_agents / c.license.max_agents, 1) : 0;
  return (
    <section className="card section">
      <div className="title-row">
        <h2>Licença</h2>
        <span className={`pill ${s.tone}`}>{s.label}</span>
      </div>
      <div className="summary">
        <div className="stat">
          <span className="muted small">Servidores em uso</span>
          <strong>
            {c.license.active_agents} de {c.license.max_agents}
          </strong>
          <div className="meter" role="meter" aria-valuenow={c.license.active_agents} aria-valuemin={0} aria-valuemax={c.license.max_agents} aria-label="Servidores em uso">
            <div className={used >= 1 ? 'meter-fill full' : 'meter-fill'} style={{ width: `${used * 100}%` }} />
          </div>
        </div>
        <div className="stat">
          <span className="muted small">Volume contratado</span>
          <strong>{c.license.max_agents ? formatBytes(c.license.max_volume_bytes) : '-'}</strong>
        </div>
        <div className="stat">
          <span className="muted small">Vigente até</span>
          <strong>{formatLastDay(c.license.valid_until)}</strong>
        </div>
      </div>
    </section>
  );
}
