import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ActionForm } from '@/components/action-form';
import { PlanFields } from '@/components/plan-fields';
import { TopBar } from '@/components/top-bar';
import { ApiError, apiGet, requireAdmin } from '@/lib/api';
import {
  dayInput,
  defaultLicenseDates,
  formatBytes,
  formatDate,
  formatDateTimeShort,
  formatLastDay,
  lastDayInput,
  licenseChangeText,
  licenseStatus,
  roleLabel,
  volumeInput,
} from '@/lib/format';
import { createLicense, createToken, disableAgent, renameTenant, revokeLicense, revokeToken, updateLicense } from '../../actions';

export const metadata: Metadata = { title: 'Empresa · Tech Audit' };

interface Detail {
  id: string;
  name: string;
  created_at: string;
  license: { status: string; max_agents: number; max_volume_bytes: string; valid_until: string | null; grace_until: string | null; active_agents: number };
  licenses: {
    id: string;
    plan: string;
    max_agents: number;
    max_volume_bytes: string;
    retention_days: number;
    valid_from: string;
    valid_until: string;
    grace_days: number;
    status: string;
  }[];
  license_history: {
    at: string;
    action: 'create' | 'update' | 'revoke';
    license_id: string | null;
    user: string | null;
    changes: Record<string, [string | number, string | number]> | null;
  }[];
  agents: { id: string; hostname: string; os: string; agent_version: string | null; last_seen_at: string | null; disabled_at: string | null; created_at: string }[];
  tokens: { id: string; description: string | null; expires_at: string; max_uses: number; uses: number; revoked_at: string | null; created_at: string; usable: boolean }[];
  users: { id: string; name: string; email: string; role: string; disabled_at: string | null }[];
}

export default async function TenantPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireAdmin();
  let t: Detail;
  try {
    t = await apiGet<Detail>(`/api/admin/tenants/${id}`);
  } catch (err) {
    if (err instanceof ApiError && (err.status === 404 || err.status === 400)) notFound();
    throw err;
  }
  const s = licenseStatus(t.license.status);
  const dates = defaultLicenseDates();
  const licenseName = (lid: string | null) => {
    const l = t.licenses.find((x) => x.id === lid);
    return l ? `${l.plan} (${formatDate(l.valid_from)} a ${formatLastDay(l.valid_until)})` : 'licença';
  };

  return (
    <>
      <TopBar user={user} active="empresas" />
      <main className="page">
        <p className="crumbs">
          <Link href="/admin/empresas">Empresas</Link> /
        </p>
        <div className="title-row">
          <h1>{t.name}</h1>
          <span className={`pill ${s.tone}`}>{s.label}</span>
        </div>

        <section className="summary">
          <div className="card stat">
            <span className="muted small">Servidores ativos</span>
            <strong>
              {t.license.active_agents} de {t.license.max_agents}
            </strong>
          </div>
          <div className="card stat">
            <span className="muted small">Volume contratado</span>
            <strong>{t.license.max_agents ? formatBytes(t.license.max_volume_bytes) : '-'}</strong>
          </div>
          <div className="card stat">
            <span className="muted small">Vigente até</span>
            <strong>{formatLastDay(t.license.valid_until)}</strong>
          </div>
          <div className="card stat">
            <span className="muted small">Usuários</span>
            <strong>{t.users.filter((u) => !u.disabled_at).length}</strong>
          </div>
        </section>

        <section className="section">
          <h2>Licenças</h2>
          <p className="muted small">
            Os limites das licenças vigentes são somados. Depois do vencimento há 1 dia de tolerância; nesse período a coleta continua, mas
            servidores novos não são aceitos.
          </p>
          {t.licenses.length > 0 && (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Plano</th>
                    <th>Situação</th>
                    <th>Vigência</th>
                    <th>Servidores</th>
                    <th>Volume</th>
                    <th>Retenção</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {t.licenses.map((l) => {
                    const ls = licenseStatus(l.status);
                    return (
                      <tr key={l.id}>
                        <td>{l.plan}</td>
                        <td>
                          <span className={`pill ${ls.tone}`}>{ls.label}</span>
                        </td>
                        <td className="nowrap">
                          {formatDate(l.valid_from)} a {formatLastDay(l.valid_until)}
                        </td>
                        <td>{l.max_agents}</td>
                        <td>{formatBytes(l.max_volume_bytes)}</td>
                        <td>{l.retention_days} dias</td>
                        <td>
                          {l.status !== 'revoked' && (
                            <div className="row-actions">
                              <details className="edit">
                                <summary className="small-btn secondary">Editar</summary>
                                <LicenseEditForm tenantId={t.id} license={l} />
                              </details>
                              <ActionForm
                                action={revokeLicense.bind(null, t.id, l.id)}
                                submit="Revogar"
                                secondary
                                confirm={`Revogar a licença ${l.plan}? Se for a única vigente, os agentes desta empresa param de enviar eventos.`}
                              />
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
          <div className="card">
            <h3>Nova licença</h3>
            <ActionForm action={createLicense.bind(null, t.id)} submit="Criar licença" className="grid-form">
              <PlanFields />
              <label>
                Servidores
                <input name="max_agents" type="number" min={1} max={10000} defaultValue={1} required />
              </label>
              <label>
                Volume contratado
                <span className="joined">
                  <input name="volume" type="number" min={1} step="any" defaultValue={500} required />
                  <select name="unit" defaultValue="GB">
                    <option>GB</option>
                    <option>TB</option>
                  </select>
                </span>
              </label>
              <label>
                Início
                <input name="valid_from" type="date" defaultValue={dates.from} required />
              </label>
              <label>
                Último dia
                <input name="valid_until" type="date" defaultValue={dates.until} required />
              </label>
            </ActionForm>
          </div>
        </section>

        {t.license_history.length > 0 && (
          <details className="section">
            <summary>Histórico de licenças</summary>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Quando</th>
                    <th>Quem</th>
                    <th>O que mudou</th>
                  </tr>
                </thead>
                <tbody>
                  {t.license_history.map((h, i) => (
                    <tr key={i}>
                      <td className="nowrap">{formatDateTimeShort(h.at)}</td>
                      <td>{h.user ?? '-'}</td>
                      <td>
                        {h.action === 'create' && <>Criou a licença {licenseName(h.license_id)}</>}
                        {h.action === 'revoke' && <>Revogou a licença {licenseName(h.license_id)}</>}
                        {h.action === 'update' && (
                          <>
                            Alterou a licença {licenseName(h.license_id)}
                            <ul className="plain-list small">
                              {Object.entries(h.changes ?? {}).map(([field, [before, after]]) => (
                                <li key={field}>{licenseChangeText(field, before, after)}</li>
                              ))}
                            </ul>
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        )}

        <section className="section">
          <h2>Servidores (agentes)</h2>
          {t.agents.length === 0 ? (
            <p className="muted">Nenhum agente registrado. Gere um token de instalação abaixo.</p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Servidor</th>
                    <th>Situação</th>
                    <th>Versão</th>
                    <th>Último contato</th>
                    <th>Registrado em</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {t.agents.map((a) => (
                    <tr key={a.id} className={a.disabled_at ? 'dim' : undefined}>
                      <td>{a.hostname}</td>
                      <td>{a.disabled_at ? <span className="pill neutral">Desativado</span> : <span className="pill ok">Ativo</span>}</td>
                      <td>{a.agent_version ?? '-'}</td>
                      <td className="nowrap">{formatDateTimeShort(a.last_seen_at)}</td>
                      <td className="nowrap">{formatDate(a.created_at)}</td>
                      <td>
                        {!a.disabled_at && (
                          <ActionForm
                            action={disableAgent.bind(null, t.id, a.id)}
                            submit="Desativar"
                            secondary
                            confirm={`Desativar ${a.hostname}? O agente para de enviar eventos e a vaga da licença é liberada.`}
                          />
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="section">
          <h2>Tokens de instalação</h2>
          <p className="muted small">
            O token é digitado no instalador do agente (baixe em <Link href="/agente">Instalar agente</Link>). Cada instalação gasta um uso; o token
            só funciona com licença vigente.
          </p>
          {t.tokens.length > 0 && (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Descrição</th>
                    <th>Situação</th>
                    <th>Usos</th>
                    <th>Válido até</th>
                    <th>Criado em</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {t.tokens.map((k) => (
                    <tr key={k.id} className={k.usable ? undefined : 'dim'}>
                      <td>{k.description ?? '-'}</td>
                      <td>
                        {k.revoked_at ? (
                          <span className="pill bad">Revogado</span>
                        ) : k.usable ? (
                          <span className="pill ok">Disponível</span>
                        ) : (
                          <span className="pill neutral">{k.uses >= k.max_uses ? 'Esgotado' : 'Vencido'}</span>
                        )}
                      </td>
                      <td>
                        {k.uses} de {k.max_uses}
                      </td>
                      <td className="nowrap">{formatDateTimeShort(k.expires_at)}</td>
                      <td className="nowrap">{formatDate(k.created_at)}</td>
                      <td>
                        {k.usable && <ActionForm action={revokeToken.bind(null, t.id, k.id)} submit="Revogar" secondary />}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="card">
            <h3>Gerar token</h3>
            <ActionForm action={createToken.bind(null, t.id)} submit="Gerar token" className="grid-form">
              <label>
                Descrição
                <input name="description" maxLength={255} placeholder="Ex.: servidor IDATA" />
              </label>
              <label>
                Instalações permitidas
                <input name="max_uses" type="number" min={1} max={1000} defaultValue={1} />
              </label>
              <label>
                Validade (horas)
                <input name="ttl_hours" type="number" min={1} max={720} defaultValue={24} />
              </label>
            </ActionForm>
          </div>
        </section>

        <section className="section">
          <div className="title-row">
            <h2>Usuários</h2>
            <Link href={`/admin/usuarios?empresa=${t.id}`}>Gerenciar usuários desta empresa</Link>
          </div>
          {t.users.length === 0 ? (
            <p className="muted">Nenhum usuário. Cadastre em Usuários.</p>
          ) : (
            <ul className="plain-list">
              {t.users.map((u) => (
                <li key={u.id} className={u.disabled_at ? 'dim' : undefined}>
                  {u.name} · {u.email} · {roleLabel(u.role)}
                  {u.disabled_at ? ' · desativado' : ''}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="section">
          <h2>Dados da empresa</h2>
          <ActionForm action={renameTenant.bind(null, t.id)} submit="Salvar nome" className="card inline-form">
            <label className="grow">
              Nome
              <input name="name" defaultValue={t.name} required maxLength={255} />
            </label>
          </ActionForm>
          <p className="muted small">Cadastrada em {formatDate(t.created_at)}. Código: {t.id}</p>
        </section>
      </main>
    </>
  );
}

// Edita a licença no lugar, sem revogar; vale na hora para os agentes.
function LicenseEditForm({ tenantId, license: l }: { tenantId: string; license: Detail['licenses'][number] }) {
  const vol = volumeInput(l.max_volume_bytes);
  return (
    <ActionForm
      action={updateLicense.bind(null, tenantId, l.id)}
      submit="Salvar alterações"
      className="stack-form"
      confirm={`Alterar a licença ${l.plan}? A mudança vale na hora para os servidores desta empresa e fica no histórico.`}
    >
      <PlanFields plan={l.plan} retentionDays={l.retention_days} />
      <label>
        Servidores
        <input name="max_agents" type="number" min={1} max={10000} defaultValue={l.max_agents} required />
      </label>
      <label>
        Volume contratado
        <span className="joined">
          <input name="volume" type="number" min={0} step="any" defaultValue={vol.value} required />
          <select name="unit" defaultValue={vol.unit}>
            <option>GB</option>
            <option>TB</option>
          </select>
        </span>
      </label>
      <label>
        Início
        <input name="valid_from" type="date" defaultValue={dayInput(l.valid_from)} required />
      </label>
      <label>
        Último dia
        <input name="valid_until" type="date" defaultValue={lastDayInput(l.valid_until)} required />
      </label>
      <label>
        Tolerância após o vencimento (dias)
        <input name="grace_days" type="number" min={0} max={90} defaultValue={l.grace_days} required />
      </label>
      <p className="muted small">Se o limite de servidores ficar abaixo dos que já estão ativos, eles continuam enviando; só novos registros são recusados.</p>
    </ActionForm>
  );
}
