import type { Metadata } from 'next';
import { ActionForm } from '@/components/action-form';
import { Drawer } from '@/components/drawer';
import { Menu } from '@/components/menu';
import { PlanFields } from '@/components/plan-fields';
import { currentTenant, Workspace } from '@/components/workspace';
import { apiGet, requireAdmin } from '@/lib/api';
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
  volumeInput,
} from '@/lib/format';
import { retentionLabel } from '@/lib/plans';
import { tenantParam } from '@/lib/workspace';
import { createLicense, renameTenant, revokeLicense, revokeToken, updateLicense } from '../admin/actions';

export const metadata: Metadata = { title: 'Licença e contrato · Tech Audit' };

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
  tokens: { id: string; description: string | null; expires_at: string; max_uses: number; uses: number; revoked_at: string | null; created_at: string; usable: boolean }[];
}

// Aba "Licença e contrato" da empresa (só administrador da Tech Master):
// licenças, tokens de instalação, histórico e dados cadastrais.
export default async function LicensePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requireAdmin();
  const tenantId = currentTenant(user, tenantParam(await searchParams));
  const t = tenantId ? await apiGet<Detail>(`/api/admin/tenants/${tenantId}`) : null;

  return (
    <Workspace user={user} tenantId={tenantId} tab="licenca" needsTenant>
      {t && <LicenseView t={t} />}
    </Workspace>
  );
}

function LicenseView({ t }: { t: Detail }) {
  const s = licenseStatus(t.license.status);
  const dates = defaultLicenseDates();
  const licenseName = (lid: string | null) => {
    const l = t.licenses.find((x) => x.id === lid);
    return l ? `${l.plan} (${formatDate(l.valid_from)} a ${formatLastDay(l.valid_until)})` : 'licença';
  };
  const usable = t.tokens.filter((k) => k.usable);

  return (
    <>
      <div className="lic-grid">
        <section className="card section">
          <div className="title-row">
            <h2>Contrato em vigor</h2>
            <span className={`pill ${s.tone}`}>{s.label}</span>
          </div>
          <dl className="kv">
            <dt>Servidores</dt>
            <dd>
              {t.license.active_agents} em uso de {t.license.max_agents}
            </dd>
            <dt>Volume contratado</dt>
            <dd>{t.license.max_agents ? formatBytes(t.license.max_volume_bytes) : '-'}</dd>
            <dt>Vigente até</dt>
            <dd>{formatLastDay(t.license.valid_until)}</dd>
            {t.license.grace_until && (
              <>
                <dt>Coleta aceita até</dt>
                <dd>{formatLastDay(t.license.grace_until)}</dd>
              </>
            )}
          </dl>
          <p className="muted small">Licenças vigentes ao mesmo tempo somam os limites. Depois do vencimento há tolerância: a coleta continua, mas servidores novos não são aceitos.</p>
        </section>

        <section className="card section">
          <h2>Tokens de instalação</h2>
          <p className="muted small">Gere novos em Servidores › Adicionar servidor.</p>
          {usable.length === 0 ? (
            <p className="muted">Nenhum token disponível agora.</p>
          ) : (
            <table className="plain-table">
              <thead>
                <tr>
                  <th>Descrição</th>
                  <th>Usos</th>
                  <th>Válido até</th>
                  <th aria-label="Ações"></th>
                </tr>
              </thead>
              <tbody>
                {usable.map((k) => (
                  <tr key={k.id}>
                    <td>{k.description ?? '-'}</td>
                    <td>
                      {k.uses} de {k.max_uses}
                    </td>
                    <td className="nowrap">{formatDateTimeShort(k.expires_at)}</td>
                    <td className="cell-menu">
                      <Menu label="⋯" ariaLabel="Ações do token">
                        <ActionForm action={revokeToken.bind(null, t.id, k.id)} submit="Revogar token" menu="danger" />
                      </Menu>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>

      <section className="section">
        <div className="title-row">
          <h2>Licenças</h2>
          <Drawer trigger="+ Nova licença" triggerClass="button secondary" title="Nova licença">
            <ActionForm action={createLicense.bind(null, t.id)} submit="Criar licença" className="stack-form">
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
          </Drawer>
        </div>
        {t.licenses.length === 0 ? (
          <p className="card empty">Nenhuma licença. Sem licença vigente os agentes não se registram nem enviam eventos.</p>
        ) : (
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
                  <th aria-label="Ações"></th>
                </tr>
              </thead>
              <tbody>
                {t.licenses.map((l) => {
                  const ls = licenseStatus(l.status);
                  return (
                    <tr key={l.id} className={l.status === 'revoked' ? 'dim' : undefined}>
                      <td>{l.plan}</td>
                      <td>
                        <span className={`pill ${ls.tone}`}>{ls.label}</span>
                      </td>
                      <td className="nowrap">
                        {formatDate(l.valid_from)} a {formatLastDay(l.valid_until)}
                      </td>
                      <td>{l.max_agents}</td>
                      <td>{formatBytes(l.max_volume_bytes)}</td>
                      <td>{retentionLabel(l.retention_days)}</td>
                      <td className="cell-menu">
                        {l.status !== 'revoked' && (
                          <Menu label="⋯" ariaLabel={`Ações da licença ${l.plan}`}>
                            <Drawer trigger="Editar licença" triggerClass="menu-item" title={`Editar licença ${l.plan}`}>
                              <LicenseEditForm tenantId={t.id} license={l} />
                            </Drawer>
                            <div className="sep" />
                            <ActionForm
                              action={revokeLicense.bind(null, t.id, l.id)}
                              submit="Revogar licença"
                              menu="danger"
                              confirm={`Revogar a licença ${l.plan}? Se for a única vigente, os agentes desta empresa param de enviar eventos.`}
                            />
                          </Menu>
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

      {t.license_history.length > 0 && (
        <section className="card section">
          <h2>Histórico do contrato</h2>
          <ul className="timeline">
            {t.license_history.map((h, i) => (
              <li key={i}>
                <span className="when">{formatDateTimeShort(h.at)}</span>
                <span>
                  <strong>{h.user ?? 'Sistema'}</strong> {h.action === 'create' && <>criou a licença {licenseName(h.license_id)}</>}
                  {h.action === 'revoke' && <>revogou a licença {licenseName(h.license_id)}</>}
                  {h.action === 'update' && (
                    <>
                      alterou a licença {licenseName(h.license_id)}
                      <ul className="plain-list small">
                        {Object.entries(h.changes ?? {}).map(([field, [before, after]]) => (
                          <li key={field}>{licenseChangeText(field, before, after)}</li>
                        ))}
                      </ul>
                    </>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="card section">
        <h2>Dados da empresa</h2>
        <ActionForm action={renameTenant.bind(null, t.id)} submit="Salvar nome" secondary className="inline-form">
          <label className="grow">
            Nome
            <input name="name" defaultValue={t.name} required maxLength={255} />
          </label>
        </ActionForm>
        <p className="muted small">
          Cadastrada em {formatDate(t.created_at)}. Código: {t.id}
        </p>
      </section>
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
