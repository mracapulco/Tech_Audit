import type { Metadata } from 'next';
import Link from 'next/link';
import { ActionForm } from '@/components/action-form';
import { AddServer, type InstallerFiles } from '@/components/add-server';
import { Drawer } from '@/components/drawer';
import { Help } from '@/components/help';
import { Menu } from '@/components/menu';
import { currentTenant, Workspace } from '@/components/workspace';
import { agentServerUrl, canDownloadAgent } from '@/lib/agent';
import { ApiError, apiGet, isMsp, type CurrentUser } from '@/lib/api';
import { ALERT_TONE, applyNotice, applyWarning, barWidth, canEditConfig, isLinux, optionsSummary, pathPlaceholder, pathStatus, removeWarning, volumeState } from '@/lib/config';
import { ago, health } from '@/lib/dashboard';
import { formatBytes, formatDateTimeShort } from '@/lib/format';
import { tenantParam, withTenant } from '@/lib/workspace';
import { createToken, disableAgent } from '../admin/actions';
import { ackAlert, addPath, reapplyPath, removePath, updatePath } from './actions';

export const metadata: Metadata = { title: 'Servidores · Tech Audit' };

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
  os: string | null;
  agent_version: string | null;
  last_seen_at: string | null;
  heartbeat: boolean;
  buffer_events: number | null;
  health: string;
  config_version: number;
  config_applied_version: number | null;
  paths: PathRow[];
}

interface View {
  tenant: { id: string; name: string };
  volume: { used_bytes: string; max_bytes: string; percent: number | null; level: number };
  read_audit_allowed: boolean;
  alerts: { id: string; kind: string; severity: string; message: string; created_at: string }[];
  agents: AgentRow[];
}

interface Installer {
  available: boolean;
  file_name?: string;
  linux?: { deb: { file_name: string } | null; rpm: { file_name: string } | null };
}

const SERVER_URL = agentServerUrl(process.env.PUBLIC_AGENT_URL ?? process.env.API_URL ?? 'http://localhost:3001');

export default async function ServersPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const user = await apiGet<CurrentUser>('/api/auth/me');
  const msp = isMsp(user);
  const tenantId = currentTenant(user, tenantParam(sp));
  const edit = canEditConfig(user.role);
  const admin = user.role === 'msp_admin';

  let view: View | null = null;
  let error: string | null = null;
  if (tenantId) {
    try {
      view = await apiGet<View>(`/api/config${msp ? `?tenant=${tenantId}` : ''}`);
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      error = err.message;
    }
  }
  let files: InstallerFiles | null = null;
  if (view && canDownloadAgent(user.role)) {
    const i = await apiGet<Installer>('/api/agent/installer');
    files = { windows: i.available ? (i.file_name ?? null) : null, deb: i.linux?.deb?.file_name ?? null, rpm: i.linux?.rpm?.file_name ?? null };
  }
  const vs = view ? volumeState(view.volume) : null;
  const link = (path: string, extra: Record<string, string> = {}) => withTenant(path, msp ? tenantId : '', extra);
  const addServer =
    view && files ? (
      <AddServer
        files={files}
        serverUrl={SERVER_URL}
        agents={view.agents.map((a) => ({ id: a.id, hostname: a.hostname }))}
        tokenAction={admin ? createToken.bind(null, tenantId) : null}
      />
    ) : null;

  return (
    <Workspace user={user} tenantId={tenantId} tab="servidores" needsTenant>
      {error && <p className="error">{error}</p>}
      {view && vs && (
        <>
          <div className="title-row">
            <h2 className="page-title">
              Servidores
              <Help>
                O agente de cada servidor busca esta configuração a cada 2 minutos e aplica sozinho a auditoria das pastas (SACL no Windows; auditd e
                Samba no Linux). Toda alteração gera um alerta, um registro no log do servidor (Application no Windows, syslog no Linux) e um registro
                no histórico.
              </Help>
            </h2>
            <Link href={link('/servidores/historico')} className="small">
              Histórico de alterações
            </Link>
            {addServer}
          </div>

          <section className="card vol">
            <strong className="nowrap">Volume auditado</strong>
            <div className="volume-bar" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={barWidth(view.volume.percent)} aria-label="Volume auditado">
              <span className={`volume-fill ${vs.tone}`} style={{ width: `${barWidth(view.volume.percent)}%` }} />
            </div>
            <span className="nowrap">
              <strong>{formatBytes(view.volume.used_bytes)}</strong> de {view.volume.max_bytes === '0' ? '-' : formatBytes(view.volume.max_bytes)} contratado
              {view.volume.percent !== null && <span className="muted"> ({String(view.volume.percent).replace('.', ',')}%)</span>}
            </span>
            {vs.tone !== 'ok' && <span className={`pill ${vs.tone}`}>{vs.label}</span>}
            <Help>
              Soma do tamanho das pastas auditadas, medida pelos agentes; pastas dentro de outra já auditada não contam de novo. Acima de 100% a
              auditoria continua, mas novos caminhos ficam bloqueados até ampliar a licença.
            </Help>
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

          {view.agents.length === 0 && (
            <section className="card empty-state">
              <h2>Nenhum servidor ainda</h2>
              <p className="muted">Instale o agente no servidor de arquivos para começar a auditar.</p>
              {addServer}
            </section>
          )}

          {view.agents.map((a) => {
            const h = health(a.health);
            const pending = a.config_applied_version !== a.config_version;
            return (
              <section key={a.id} id={`srv-${a.id}`} className="srv">
                <div className="srv-head">
                  <h2>{a.hostname}</h2>
                  <span className={`pill ${h.tone}`}>{h.label}</span>
                  <span className="meta">
                    {[a.os, a.agent_version && `agente ${a.agent_version}`, `último contato ${ago(a.last_seen_at)}`].filter(Boolean).join(' · ')}
                    {a.heartbeat && (a.buffer_events ?? 0) > 0 && <> · {a.buffer_events} eventos aguardando envio</>}
                    {pending && <span className="warn-text"> · alteração aguardando o agente</span>}
                  </span>
                  <div className="srv-actions">
                    <Menu label="⋯" ariaLabel={`Ações do servidor ${a.hostname}`}>
                      <Link className="menu-item" href={link('/servidores/historico', { servidor: a.id })}>
                        Histórico de alterações
                      </Link>
                      {admin && (
                        <>
                          <div className="sep" />
                          <ActionForm
                            action={disableAgent.bind(null, tenantId, a.id)}
                            submit="Desativar servidor"
                            menu="danger"
                            confirm={`Desativar ${a.hostname}? O agente para de enviar eventos e a vaga da licença é liberada.`}
                          />
                        </>
                      )}
                    </Menu>
                  </div>
                </div>

                {a.paths.length === 0 ? (
                  <p className="muted srv-empty">Nenhuma pasta auditada neste servidor.</p>
                ) : (
                  <table className="srv-table">
                    <thead>
                      <tr>
                        <th>Pasta auditada</th>
                        <th>Situação</th>
                        <th>O que registra</th>
                        <th>Tamanho</th>
                        <th aria-label="Ações"></th>
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
                              <span className={`pill ${st.tone}`} title={p.applied_at ? `${st.hint} Aplicado em ${formatDateTimeShort(p.applied_at)}.` : st.hint}>
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
                            <td className="cell-menu">
                              <Menu label="⋯" ariaLabel={`Ações de ${p.path}`}>
                                <Link className="menu-item" href={link('/eventos', { caminho: p.path, periodo: '7d' })}>
                                  Ver eventos desta pasta
                                </Link>
                                {edit && !removing && (
                                  <>
                                    <Drawer trigger="Editar opções" triggerClass="menu-item" title={`Editar ${p.path}`}>
                                      <p className="muted small">Servidor {a.hostname}</p>
                                      <ActionForm action={updatePath.bind(null, p.id)} submit="Salvar" confirm={applyWarning(p.path, a.hostname, a.os)} className="stack-form">
                                        <PathOptions recursive={p.recursive} auditRead={p.audit_read} exclusions={p.exclusions} readAllowed={view.read_audit_allowed} />
                                      </ActionForm>
                                    </Drawer>
                                    {(p.status === 'error' || p.status === 'divergent' || p.status === 'applied') && (
                                      <ActionForm action={reapplyPath.bind(null, p.id)} submit="Reaplicar auditoria" menu confirm={applyWarning(p.path, a.hostname, a.os)} />
                                    )}
                                    <div className="sep" />
                                    <ActionForm action={removePath.bind(null, p.id)} submit="Parar de auditar" menu="danger" confirm={removeWarning(p.path, a.hostname, a.os)} />
                                  </>
                                )}
                              </Menu>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}

                {edit && (
                  <div className="srv-foot">
                    <Drawer trigger="+ Adicionar pasta" triggerClass="link-btn" title={`Adicionar pasta em ${a.hostname}`}>
                      <ActionForm action={addPath.bind(null, a.id)} submit="Adicionar pasta" confirm={applyWarning('{{path}}', a.hostname, a.os)} className="stack-form">
                        <label>
                          Caminho local no servidor {isLinux(a.os) ? '(Linux)' : '(Windows)'}
                          <input name="path" required maxLength={1024} placeholder={pathPlaceholder(a.os)} className="path-input" />
                        </label>
                        <PathOptions recursive auditRead={false} exclusions={[]} readAllowed={view.read_audit_allowed} />
                        {admin && vs.tone === 'bad' && (
                          <label className="check">
                            <input type="checkbox" name="override_volume" /> Liberar acima do volume contratado (administrador Tech Master)
                          </label>
                        )}
                        <p className="notice small">{applyNotice(a.os)}</p>
                        <label className="check">
                          <input type="checkbox" name="ciente" required /> Estou ciente de que o agente vai alterar a configuração de auditoria deste servidor
                        </label>
                      </ActionForm>
                    </Drawer>
                  </div>
                )}
              </section>
            );
          })}
        </>
      )}
    </Workspace>
  );
}

function PathOptions({ recursive, auditRead, exclusions, readAllowed }: { recursive: boolean; auditRead: boolean; exclusions: string[]; readAllowed: boolean }) {
  // Fora do plano, a leitura não pode ser ligada; se já estava ligada, pode ser desligada.
  const readLocked = !readAllowed && !auditRead;
  return (
    <>
      <label className="check">
        <input type="checkbox" name="recursive" defaultChecked={recursive} /> Incluir subpastas e arquivos
      </label>
      <label className="check">
        <input type="checkbox" name="audit_read" defaultChecked={auditRead} disabled={readLocked} /> Auditar também leituras (gera muito mais eventos)
      </label>
      {!readAllowed && (
        <p className="muted small">
          {readLocked
            ? 'A auditoria de leitura não faz parte do plano Essencial. Fale com a Tech Master para mudar o plano.'
            : 'O plano atual não inclui auditoria de leitura: ela continua neste caminho, mas, se desligada, não poderá ser ligada de novo.'}
        </p>
      )}
      <label>
        Ignorar (um padrão por linha, ex.: *.tmp, ~$*)
        <textarea name="exclusions" rows={3} defaultValue={exclusions.join('\n')} className="path-input" />
      </label>
    </>
  );
}
