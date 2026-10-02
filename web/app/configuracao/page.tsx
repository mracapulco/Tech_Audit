import type { Metadata } from 'next';
import Link from 'next/link';
import { ActionForm } from '@/components/action-form';
import { TopBar } from '@/components/top-bar';
import { ApiError, apiGet, isMsp, type CurrentUser } from '@/lib/api';
import { ALERT_TONE, applyWarning, barWidth, canEditConfig, optionsSummary, pathStatus, volumeState } from '@/lib/config';
import { formatBytes, formatDateTimeShort } from '@/lib/format';
import { ackAlert, addPath, reapplyPath, removePath, updatePath } from './actions';

export const metadata: Metadata = { title: 'Caminhos auditados · Tech Audit' };

interface PathRow {
  id: string;
  path: string;
  recursive: boolean;
  audit_read: boolean;
  exclusions: string[];
  desired_state: string;
  status: string;
  last_error: string | null;
  applied_at: string | null;
  size_bytes: string | null;
  size_error: string | null;
  size_measured_at: string | null;
}

interface AgentRow {
  id: string;
  hostname: string;
  last_seen_at: string | null;
  config_version: number;
  config_applied_version: number | null;
  config_fetched_at: string | null;
  paths: PathRow[];
}

interface View {
  tenant: { id: string; name: string };
  volume: { used_bytes: string; max_bytes: string; percent: number | null; level: number };
  alerts: { id: string; kind: string; severity: string; message: string; created_at: string }[];
  agents: AgentRow[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function ConfigPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const user = await apiGet<CurrentUser>('/api/auth/me');
  const msp = isMsp(user);
  const tenants = msp ? await apiGet<{ id: string; name: string }[]>('/api/tenants') : [];
  const empresa = typeof sp.empresa === 'string' && UUID.test(sp.empresa) ? sp.empresa : msp ? (tenants[0]?.id ?? '') : '';
  const edit = canEditConfig(user.role);

  let view: View | null = null;
  let error: string | null = null;
  if (!msp || empresa) {
    try {
      view = await apiGet<View>(`/api/config${msp ? `?tenant=${empresa}` : ''}`);
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      error = err.message;
    }
  }
  const vs = view ? volumeState(view.volume) : null;
  const historyHref = `/configuracao/historico${msp && empresa ? `?empresa=${empresa}` : ''}`;

  return (
    <>
      <TopBar user={user} active="configuracao" />
      <main className="page">
        <div className="title-row">
          <h1>Caminhos auditados</h1>
          <Link href={historyHref}>Histórico de alterações</Link>
        </div>

        {msp && (
          <form method="get" className="filter-row">
            <label>
              Empresa
              <select name="empresa" defaultValue={empresa}>
                {tenants.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </label>
            <button type="submit" className="secondary">
              Abrir
            </button>
          </form>
        )}

        {error && <p className="error">{error}</p>}
        {msp && tenants.length === 0 && <p className="muted">Nenhuma empresa cadastrada.</p>}

        {view && vs && (
          <>
            <p className="muted small">
              O agente de cada servidor busca esta configuração a cada 2 minutos e aplica sozinho a política de auditoria e a SACL das pastas. Toda
              alteração gera um alerta, um evento no log Application do servidor e um registro no histórico.
            </p>

            <section className="card volume">
              <div className="title-row">
                <h2>Volume auditado</h2>
                <span className={`pill ${vs.tone}`}>{vs.label}</span>
              </div>
              <div className="bar" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={barWidth(view.volume.percent)} aria-label="Volume auditado">
                <span className={`bar-fill ${vs.tone}`} style={{ width: `${barWidth(view.volume.percent)}%` }} />
              </div>
              <p className="small">
                <strong>{formatBytes(view.volume.used_bytes)}</strong> de {view.volume.max_bytes === '0' ? '-' : formatBytes(view.volume.max_bytes)} contratados
                {view.volume.percent !== null && <> ({String(view.volume.percent).replace('.', ',')}%)</>}
              </p>
              <p className="muted small">
                Soma do tamanho das pastas auditadas, medida pelos agentes; pastas dentro de outra já auditada não contam de novo. Acima de 100% a
                auditoria continua, mas novos caminhos ficam bloqueados até ampliar a licença.
              </p>
            </section>

            {view.alerts.length > 0 && (
              <section className="section">
                <h2>Alertas</h2>
                <ul className="alerts">
                  {view.alerts.map((a) => (
                    <li key={a.id} className="card alert">
                      <span className={`pill ${ALERT_TONE[a.severity] ?? 'neutral'}`}>{formatDateTimeShort(a.created_at)}</span>
                      <span className="grow">{a.message}</span>
                      <ActionForm action={ackAlert.bind(null, a.id)} submit="Ciente" secondary />
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {view.agents.length === 0 && <p className="muted">Nenhum servidor com agente ativo nesta empresa.</p>}

            {view.agents.map((a) => (
              <section key={a.id} className="section">
                <div className="title-row">
                  <h2>{a.hostname}</h2>
                  <span className="muted small">
                    Último contato: {formatDateTimeShort(a.last_seen_at)} ·{' '}
                    {a.config_applied_version === a.config_version ? (
                      'configuração em dia'
                    ) : (
                      <span className="warn-text">alteração aguardando o agente</span>
                    )}
                  </span>
                </div>

                {a.paths.length === 0 ? (
                  <p className="muted">Nenhum caminho auditado neste servidor.</p>
                ) : (
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Caminho</th>
                          <th>Situação</th>
                          <th>Opções</th>
                          <th>Tamanho</th>
                          <th>Aplicado em</th>
                          {edit && <th></th>}
                        </tr>
                      </thead>
                      <tbody>
                        {a.paths.map((p) => {
                          const st = pathStatus(p.status);
                          const removing = p.desired_state !== 'active';
                          return (
                            <tr key={p.id} className={removing ? 'dim' : undefined}>
                              <td className="path">{p.path}</td>
                              <td>
                                <span className={`pill ${st.tone}`} title={st.hint}>
                                  {st.label}
                                </span>
                                {p.last_error && <p className="fail small cell-note">{p.last_error}</p>}
                              </td>
                              <td className="small">
                                {optionsSummary(p)}
                                {p.exclusions.length > 0 && <p className="muted cell-note path">{p.exclusions.join('  ')}</p>}
                              </td>
                              <td className="nowrap" title={p.size_measured_at ? `Medido em ${formatDateTimeShort(p.size_measured_at)}` : undefined}>
                                {p.size_bytes !== null ? formatBytes(p.size_bytes) : p.size_error ? <span className="fail small">{p.size_error}</span> : <span className="muted">Medindo…</span>}
                              </td>
                              <td className="nowrap">{formatDateTimeShort(p.applied_at)}</td>
                              {edit && (
                                <td>
                                  {!removing && (
                                    <div className="row-actions">
                                      <details className="edit">
                                        <summary className="small-btn secondary">Editar</summary>
                                        <ActionForm action={updatePath.bind(null, p.id)} submit="Salvar" confirm={applyWarning(p.path, a.hostname)} className="stack-form">
                                          <PathOptions recursive={p.recursive} auditRead={p.audit_read} exclusions={p.exclusions} />
                                        </ActionForm>
                                      </details>
                                      {(p.status === 'error' || p.status === 'divergent' || p.status === 'applied') && (
                                        <ActionForm action={reapplyPath.bind(null, p.id)} submit="Reaplicar" secondary confirm={applyWarning(p.path, a.hostname)} />
                                      )}
                                      <ActionForm
                                        action={removePath.bind(null, p.id)}
                                        submit="Remover"
                                        secondary
                                        confirm={`Parar de auditar ${p.path} em ${a.hostname}? O agente retira a auditoria que ele mesmo adicionou na SACL; os eventos já coletados continuam no histórico.`}
                                      />
                                    </div>
                                  )}
                                </td>
                              )}
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}

                {edit && (
                  <details className="card add-path">
                    <summary>Adicionar caminho em {a.hostname}</summary>
                    <ActionForm
                      action={addPath.bind(null, a.id)}
                      submit="Adicionar caminho"
                      confirm={applyWarning('{{path}}', a.hostname)}
                      className="stack-form"
                    >
                      <label>
                        Caminho local no servidor
                        <input name="path" required maxLength={1024} placeholder="D:\Dados\Financeiro" className="path-input" />
                      </label>
                      <PathOptions recursive auditRead={false} exclusions={[]} />
                      {user.role === 'msp_admin' && vs.tone === 'bad' && (
                        <label className="check">
                          <input type="checkbox" name="override_volume" /> Liberar acima do volume contratado (administrador Tech Master)
                        </label>
                      )}
                      <p className="notice small">
                        O agente vai habilitar a auditoria de “Sistema de arquivos” no Windows e adicionar uma entrada de auditoria (SACL) nesta pasta,
                        sem remover as que já existem. Isso aumenta o volume do log de Segurança do Windows.
                      </p>
                      <label className="check">
                        <input type="checkbox" name="ciente" required /> Estou ciente de que o agente vai alterar a configuração de auditoria deste servidor
                      </label>
                    </ActionForm>
                  </details>
                )}
              </section>
            ))}
          </>
        )}
      </main>
    </>
  );
}

function PathOptions({ recursive, auditRead, exclusions }: { recursive: boolean; auditRead: boolean; exclusions: string[] }) {
  return (
    <>
      <label className="check">
        <input type="checkbox" name="recursive" defaultChecked={recursive} /> Incluir subpastas e arquivos
      </label>
      <label className="check">
        <input type="checkbox" name="audit_read" defaultChecked={auditRead} /> Auditar também leituras (gera muito mais eventos)
      </label>
      <label>
        Ignorar (um padrão por linha, ex.: *.tmp, ~$*)
        <textarea name="exclusions" rows={3} defaultValue={exclusions.join('\n')} className="path-input" />
      </label>
    </>
  );
}
