import type { Metadata } from 'next';
import { ActionForm } from '@/components/action-form';
import { Drawer } from '@/components/drawer';
import { Help } from '@/components/help';
import { Menu } from '@/components/menu';
import { currentTenant, Workspace } from '@/components/workspace';
import { ApiError, apiGet, isMsp, type CurrentUser } from '@/lib/api';
import { REPORT_TYPES } from '@/lib/dashboard';
import { actionGroups } from '@/lib/filters';
import { formatDateTimeShort } from '@/lib/format';
import { canEditNotifications, deliveryKind, deliveryStatus, FORMATS, FREQUENCIES, HOURS, recipientsText, WEEKDAYS } from '@/lib/notifications';
import { tenantParam } from '@/lib/workspace';
import { createReport, deleteReport, saveAlerts, sendReportNow, sendTest, setReportEnabled, updateReport } from './actions';

export const metadata: Metadata = { title: 'Alertas e e-mails · Tech Audit' };

interface Scheduled {
  id: string;
  name: string;
  report_type: string;
  report_title: string;
  format: string;
  frequency: string;
  weekday: number | null;
  hour: number;
  schedule_label: string;
  filter_user: string | null;
  filter_path: string | null;
  filter_action: string | null;
  recipients: string[];
  enabled: boolean;
  next_run_at: string;
  last_run_at: string | null;
  last_status: string | null;
  last_error: string | null;
}

interface View {
  tenant: { id: string; name: string };
  email_configured: boolean;
  plan_allows: boolean;
  alerts: {
    saved: boolean;
    recipients: string[];
    groups: { key: string; label: string; enabled: boolean }[];
    mass_delete_threshold: number;
    mass_delete_window_minutes: number;
  };
  reports: Scheduled[];
  deliveries: { id: string; kind: string; subject: string; recipients: string[]; status: string; error: string | null; created_at: string }[];
}

type SP = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.trim() ?? '';

export default async function AlertsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const user = await apiGet<CurrentUser>('/api/auth/me');
  const msp = isMsp(user);
  const tenantId = currentTenant(user, tenantParam(sp));

  let view: View | null = null;
  let error: string | null = null;
  if (tenantId) {
    try {
      view = await apiGet<View>(`/api/notifications${msp ? `?tenant=${tenantId}` : ''}`);
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      error = err.message;
    }
  }

  return (
    <Workspace user={user} tenantId={tenantId} tab="alertas" needsTenant>
      {error && <p className="error">{error}</p>}
      {view && <AlertsView view={view} tenantId={msp ? tenantId : ''} edit={canEditNotifications(user.role) && view.plan_allows} msp={msp} sp={sp} />}
    </Workspace>
  );
}

function AlertsView({ view, tenantId, edit, msp, sp }: { view: View; tenantId: string; edit: boolean; msp: boolean; sp: SP }) {
  const a = view.alerts;
  // Vindo de "Agendar por e-mail" na tela de relatórios: formulário aberto e preenchido.
  const prefill = REPORT_TYPES.some((t) => t.key === one(sp.agendar))
    ? { report_type: one(sp.agendar), filter_user: one(sp.usuario), filter_path: one(sp.caminho), filter_action: one(sp.acao) }
    : null;
  return (
    <>
      <div className="title-row">
        <h2 className="page-title">
          Alertas e e-mails
          <Help>
            O Tech Audit confere a cada minuto se algum servidor parou de enviar dados e se algum usuário excluiu muitos arquivos de uma vez. Os
            alertas aparecem na aba Servidores e, se ligados aqui, vão por e-mail: os alertas novos de cada minuto chegam juntos, num e-mail só.
            Os relatórios agendados vão em anexo, em PDF ou Excel, no horário de Brasília.
          </Help>
        </h2>
      </div>

      {!view.plan_allows && (
        <p className="notice">
          Alertas e relatórios por e-mail fazem parte dos planos Profissional e Enterprise. {msp ? 'Mude o plano na aba Licença e contrato.' : 'Fale com a Tech Master para mudar o plano.'}
        </p>
      )}
      {view.plan_allows && !view.email_configured && (
        <p className="notice">
          {msp
            ? 'O envio de e-mail ainda não está configurado no servidor (SMTP_HOST no .env). As configurações podem ser salvas, mas nada será enviado até lá.'
            : 'O envio de e-mail está sendo configurado pela Tech Master. As configurações podem ser salvas e passam a valer assim que estiver pronto.'}
        </p>
      )}

      <section className="card section">
        <h2>Alertas por e-mail</h2>
        {edit ? (
          <>
            <ActionForm action={saveAlerts.bind(null, tenantId)} submit="Salvar alertas" className="stack-form">
              <label>
                Quem recebe (um e-mail por linha, até 10)
                <textarea name="recipients" rows={3} defaultValue={recipientsText(a.recipients)} placeholder="ti@suaempresa.com.br" />
              </label>
              <fieldset className="checks">
                <legend className="small muted">O que enviar</legend>
                {a.groups.map((g) => (
                  <label key={g.key} className="check">
                    <input type="checkbox" name="groups" value={g.key} defaultChecked={g.enabled} /> {g.label}
                  </label>
                ))}
              </fieldset>
              <div className="inline-form">
                <label>
                  Exclusão em massa: a partir de
                  <input type="number" name="mass_delete_threshold" min={10} max={100000} defaultValue={a.mass_delete_threshold} />
                </label>
                <label>
                  exclusões do mesmo usuário em até (minutos)
                  <input type="number" name="mass_delete_window_minutes" min={1} max={60} defaultValue={a.mass_delete_window_minutes} />
                </label>
              </div>
            </ActionForm>
            {a.recipients.length > 0 && (
              <ActionForm action={sendTest.bind(null, tenantId)} submit="Enviar e-mail de teste" secondary />
            )}
          </>
        ) : (
          <dl className="facts">
            <div>
              <dt>Quem recebe</dt>
              <dd>{a.recipients.length ? a.recipients.join(', ') : <span className="muted">ninguém</span>}</dd>
            </div>
            <div>
              <dt>O que enviar</dt>
              <dd>
                {a.groups
                  .filter((g) => g.enabled)
                  .map((g) => g.label)
                  .join('; ') || <span className="muted">nada</span>}
              </dd>
            </div>
            <div>
              <dt>Exclusão em massa</dt>
              <dd>
                {a.mass_delete_threshold} exclusões em até {a.mass_delete_window_minutes} minutos
              </dd>
            </div>
          </dl>
        )}
      </section>

      <section className="section" id="agendados">
        <div className="title-row">
          <h2>Relatórios agendados</h2>
          {edit && (
            <Drawer trigger="+ Agendar relatório" title="Agendar relatório por e-mail" defaultOpen={!!prefill}>
              <ActionForm action={createReport.bind(null, tenantId)} submit="Agendar" className="stack-form">
                <ScheduleFields r={prefill ?? {}} />
              </ActionForm>
            </Drawer>
          )}
        </div>
        {view.reports.length === 0 ? (
          <p className="card empty">Nenhum relatório agendado.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Nome</th>
                  <th>Quando</th>
                  <th>Para</th>
                  <th>Último envio</th>
                  <th aria-label="Ações"></th>
                </tr>
              </thead>
              <tbody>
                {view.reports.map((r) => {
                  const st = deliveryStatus(r.last_status);
                  return (
                    <tr key={r.id} className={r.enabled ? undefined : 'dim'}>
                      <td>
                        <strong>{r.name}</strong>
                        <p className="muted small cell-note">
                          {r.report_title} · {r.format === 'xlsx' ? 'Excel' : 'PDF'}
                          {[r.filter_user && `usuário "${r.filter_user}"`, r.filter_path && `pasta ${r.filter_path}`, r.filter_action && 'ação filtrada']
                            .filter(Boolean)
                            .map((x) => ` · ${x}`)
                            .join('')}
                        </p>
                      </td>
                      <td className="small">
                        {r.schedule_label}
                        <p className="muted cell-note">{r.enabled ? `Próximo: ${formatDateTimeShort(r.next_run_at)}` : 'Pausado'}</p>
                      </td>
                      <td className="small">{r.recipients.join(', ')}</td>
                      <td className="small">
                        <span className={`pill ${st.tone}`}>{st.label}</span>
                        {r.last_run_at && <p className="muted cell-note">{formatDateTimeShort(r.last_run_at)}</p>}
                        {r.last_error && <p className="fail cell-note">{r.last_error}</p>}
                      </td>
                      <td className="cell-menu">
                        {edit && (
                          <div className="row-actions">
                            <ActionForm action={sendReportNow.bind(null, r.id)} submit="Enviar agora" secondary />
                            <Menu label="⋯" ariaLabel={`Ações de ${r.name}`}>
                              <Drawer trigger="Editar" triggerClass="menu-item" title={`Editar ${r.name}`}>
                                <ActionForm action={updateReport.bind(null, r.id)} submit="Salvar" className="stack-form">
                                  <ScheduleFields r={r} />
                                </ActionForm>
                              </Drawer>
                              <ActionForm action={setReportEnabled.bind(null, r.id, !r.enabled)} submit={r.enabled ? 'Pausar envio' : 'Retomar envio'} menu />
                              <div className="sep" />
                              <ActionForm action={deleteReport.bind(null, r.id)} submit="Excluir" menu="danger" confirm={`Excluir o relatório agendado "${r.name}"?`} />
                            </Menu>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="section">
        <h2>Últimos envios</h2>
        {view.deliveries.length === 0 ? (
          <p className="card empty">Nenhum e-mail enviado ainda.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Data</th>
                  <th>Tipo</th>
                  <th>Assunto</th>
                  <th>Para</th>
                  <th>Situação</th>
                </tr>
              </thead>
              <tbody>
                {view.deliveries.map((d) => {
                  const st = deliveryStatus(d.status);
                  return (
                    <tr key={d.id}>
                      <td className="nowrap">{formatDateTimeShort(d.created_at)}</td>
                      <td className="nowrap">{deliveryKind(d.kind)}</td>
                      <td>{d.subject}</td>
                      <td className="small">{d.recipients.join(', ')}</td>
                      <td>
                        <span className={`pill ${st.tone}`}>{st.label}</span>
                        {d.error && <p className="fail small cell-note">{d.error}</p>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

function ScheduleFields({ r }: { r: Partial<Scheduled> }) {
  const type = r.report_type ?? 'usuarios';
  const title = REPORT_TYPES.find((t) => t.key === type)?.label ?? '';
  return (
    <>
      <label>
        Nome
        <input name="name" required maxLength={120} defaultValue={r.name ?? `Relatório ${title.toLowerCase()}`} />
      </label>
      <div className="inline-form">
        <label>
          Relatório
          <select name="report_type" defaultValue={type}>
            {REPORT_TYPES.map((t) => (
              <option key={t.key} value={t.key}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Formato
          <select name="format" defaultValue={r.format ?? 'pdf'}>
            {FORMATS.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="inline-form">
        <label>
          Frequência
          <select name="frequency" defaultValue={r.frequency ?? 'weekly'}>
            {FREQUENCIES.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <label>
          Dia (semanal)
          <select name="weekday" defaultValue={r.weekday ?? 1}>
            {WEEKDAYS.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <label>
          Hora
          <select name="hour" defaultValue={r.hour ?? 7}>
            {HOURS.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </label>
      </div>
      <details open={!!(r.filter_user || r.filter_path || r.filter_action)}>
        <summary className="small">Filtros (opcional)</summary>
        <div className="stack-form">
          <label>
            Usuário
            <input name="filter_user" maxLength={256} defaultValue={r.filter_user ?? ''} placeholder="joao.silva, DOMINIO\joao ou SID" />
          </label>
          <label>
            Caminho (inclui subpastas)
            <input name="filter_path" maxLength={1024} defaultValue={r.filter_path ?? ''} placeholder="D:\Dados\Financeiro" className="path-input" />
          </label>
          <label>
            Ação
            <select name="filter_action" defaultValue={r.filter_action ?? ''}>
              <option value="">Todas</option>
              {actionGroups(r.filter_action ?? '').map((g) => (
                <optgroup key={g.label} label={g.label}>
                  {g.options.map(([v, l]) => (
                    <option key={v} value={v}>
                      {l}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>
        </div>
      </details>
      <label>
        Para (um e-mail por linha, até 10)
        <textarea name="recipients" rows={3} required defaultValue={recipientsText(r.recipients ?? [])} placeholder="diretoria@suaempresa.com.br" />
      </label>
    </>
  );
}
