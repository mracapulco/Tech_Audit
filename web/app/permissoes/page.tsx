import type { Metadata } from 'next';
import Link from 'next/link';
import { ActionForm } from '@/components/action-form';
import { Help } from '@/components/help';
import { currentTenant, Workspace } from '@/components/workspace';
import { ApiError, apiGet, isMsp, type CurrentUser } from '@/lib/api';
import { formatInt } from '@/lib/dashboard';
import { formatDateTimeShort } from '@/lib/format';
import { folderBadge, groupByFolder, kindLabel, permApiQuery, permFilters, permScreenQuery, scanText, type PermRow, type PermView } from '@/lib/permissions';
import { tenantParam } from '@/lib/workspace';
import { refreshPermissions } from './actions';

export const metadata: Metadata = { title: 'Permissões · Tech Audit' };

export default async function PermissionsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const user = await apiGet<CurrentUser>('/api/auth/me');
  const msp = isMsp(user);
  const tenantId = currentTenant(user, tenantParam(sp));
  const f = permFilters(sp);
  const apiTenant = msp ? tenantId : '';

  let view: PermView | null = null;
  let error: string | null = null;
  if (tenantId) {
    try {
      view = await apiGet<PermView>(`/api/permissions?${permApiQuery(f, apiTenant)}`);
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      error = err.message;
    }
  }
  const download = (formato: string) => `/permissoes/exportar?${permScreenQuery(f, apiTenant, { formato })}`;
  const filtered = !!(f.servidor || f.caminho || f.busca || f.proprias || f.negacoes);
  const groups = view ? groupByFolder(view.rows) : [];
  const paths = view ? view.agents.filter((a) => !f.servidor || a.id === f.servidor).flatMap((a) => a.paths.map((p) => ({ ...p, hostname: a.hostname }))) : [];

  return (
    <Workspace user={user} tenantId={tenantId} tab="permissoes" needsTenant>
      {error && <p className="error">{error}</p>}
      {view && (
        <>
          <div className="title-row">
            <h2 className="page-title">
              Permissões
              <Help>
                Quem tem acesso a cada pasta auditada. O agente lê as permissões uma vez por dia (e quando você pede &quot;Atualizar agora&quot;), sem
                alterar nada no servidor. Para não repetir a mesma permissão em milhares de subpastas, aparecem a pasta auditada e só as subpastas com
                permissão própria (herança desligada ou entradas definidas nela; no Linux, dono, grupo ou ACL diferentes da pasta de cima). O acesso
                real pela rede é o menor entre a permissão do compartilhamento e a da pasta.
              </Help>
            </h2>
            {view.allowed && (
              <div className="form-actions">
                <a className="button" href={download('xlsx')} download>
                  Baixar Excel
                </a>
                <a className="button secondary" href={download('pdf')} download>
                  Baixar PDF
                </a>
              </div>
            )}
          </div>

          {!view.allowed ? (
            <section className="card empty-state">
              <h2>Inventário de permissões faz parte do plano Enterprise</h2>
              <p className="muted">
                Mostra quem tem acesso a cada pasta auditada (usuários, grupos, compartilhamentos), com Excel e PDF para auditoria. Fale com a Tech
                Master para mudar o plano.
              </p>
            </section>
          ) : view.agents.length === 0 ? (
            <section className="card empty-state">
              <h2>Nenhum servidor ainda</h2>
              <p className="muted">Instale o agente e cadastre as pastas auditadas na aba Servidores.</p>
            </section>
          ) : (
            <>
              <section className="section">
                <h2>Coletas</h2>
                <div className="perm-agents">
                  {view.agents.map((a) => (
                    <div key={a.id} className="card perm-agent">
                      <div className="perm-agent-head">
                        <strong>{a.hostname}</strong>
                        <span className="muted small">
                          {a.scanned_at ? `última coleta ${formatDateTimeShort(a.scanned_at)}` : 'nenhuma coleta ainda'}
                          {a.pending && <span className="warn-text"> · coleta pedida, aguardando o agente</span>}
                        </span>
                        {a.supported && a.paths.length > 0 && (
                          <ActionForm action={refreshPermissions.bind(null, apiTenant, a.id)} submit="Atualizar agora" secondary />
                        )}
                      </div>
                      {!a.supported && (
                        <p className="notice small">
                          O agente deste servidor ({a.agent_version ?? 'versão desconhecida'}) não faz o inventário. Instale a versão 0.5.0 ou mais nova
                          (aba Servidores, Adicionar servidor).
                        </p>
                      )}
                      {a.paths.length === 0 ? (
                        <p className="muted small">Nenhuma pasta auditada neste servidor.</p>
                      ) : (
                        <ul className="perm-paths">
                          {a.paths.map((p) => {
                            const s = scanText(p.scan);
                            return (
                              <li key={p.id}>
                                <span className="path">{p.path}</span>
                                <span className={`pill ${s.tone}`} title={p.scan?.finished_at ? `Concluída em ${formatDateTimeShort(p.scan.finished_at)}` : undefined}>
                                  {s.label}
                                </span>
                                {s.detail && <span className={`small ${s.tone === 'bad' ? 'fail' : 'muted'}`}>{s.detail}</span>}
                              </li>
                            );
                          })}
                        </ul>
                      )}
                    </div>
                  ))}
                </div>
              </section>

              <form method="get" className="card filters">
                {msp && tenantId && <input type="hidden" name="cliente" value={tenantId} />}
                <label>
                  Servidor
                  <select name="servidor" defaultValue={f.servidor}>
                    <option value="">Todos</option>
                    {view.agents.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.hostname}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="wide">
                  Pasta auditada
                  <select name="caminho" defaultValue={f.caminho}>
                    <option value="">Todas</option>
                    {paths.map((p) => (
                      <option key={p.id} value={p.id}>
                        {view.agents.length > 1 ? `${p.hostname}: ` : ''}
                        {p.path}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="wide">
                  Usuário, grupo ou pasta
                  <input name="busca" defaultValue={f.busca} placeholder="Financeiro, joao.silva ou RH" />
                </label>
                <label className="check">
                  <input type="checkbox" name="proprias" value="1" defaultChecked={f.proprias} /> Só permissões definidas na própria pasta
                </label>
                <label className="check">
                  <input type="checkbox" name="negacoes" value="1" defaultChecked={f.negacoes} /> Só negações
                </label>
                <div className="buttons">
                  <button type="submit">Filtrar</button>
                  {filtered && (
                    <Link className="button secondary" href={`/permissoes?${permScreenQuery({ servidor: '', caminho: '', busca: '', proprias: false, negacoes: false }, apiTenant)}`}>
                      Limpar
                    </Link>
                  )}
                </div>
              </form>

              <section className="section">
                {groups.length === 0 ? (
                  <p className="card empty">
                    {filtered ? 'Nenhuma permissão encontrada com esses filtros.' : 'Ainda não há coleta concluída. O agente coleta logo depois de receber a configuração.'}
                  </p>
                ) : (
                  <>
                    <p className="muted small">
                      {formatInt(groups.length)} pasta(s) e compartilhamento(s), {formatInt(view.rows.filter((r) => r.principal !== null).length)} permissão(ões)
                      {view.truncated && (
                        <>
                          {' '}
                          · <span className="warn-text">Mostrando só as primeiras {formatInt(view.rows.length)}.</span> Use os filtros ou baixe o Excel para
                          ver tudo.
                        </>
                      )}
                    </p>
                    <div className="table-wrap">
                      <table className="perm-table">
                        <thead>
                          <tr>
                            <th>Usuário ou grupo</th>
                            <th>Permissão</th>
                            <th>Vale para</th>
                            <th>Herdada</th>
                          </tr>
                        </thead>
                        {groups.map((g) => {
                          const b = folderBadge(g);
                          return (
                            <tbody key={g.key}>
                              <tr className="perm-folder">
                                <th colSpan={4} scope="colgroup">
                                  <span className="path">{g.folder}</span>
                                  <span className={`pill ${b.tone}`}>{b.label}</span>
                                  {view.agents.length > 1 && <span className="muted small">{g.hostname}</span>}
                                  {g.owner && <span className="muted small">dono: {g.owner}</span>}
                                  {g.error && <span className="fail small">{g.error}</span>}
                                </th>
                              </tr>
                              {g.rows.length === 0 && !g.error && (
                                <tr>
                                  <td colSpan={4} className="muted small">
                                    Nenhuma permissão: ninguém tem acesso a esta pasta.
                                  </td>
                                </tr>
                              )}
                              {g.rows.map((r, i) => (
                                <PermLine key={i} r={r} />
                              ))}
                            </tbody>
                          );
                        })}
                      </table>
                    </div>
                  </>
                )}
              </section>

              {view.removed.length > 0 && (
                <section className="section">
                  <h2>Removidas desde a coleta anterior</h2>
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Pasta</th>
                          <th>Usuário ou grupo</th>
                          <th>Permissão</th>
                          <th>Vale para</th>
                        </tr>
                      </thead>
                      <tbody>
                        {view.removed.map((r, i) => (
                          <tr key={i}>
                            <td className="path">
                              {r.folder_path}
                              {r.source === 'share' && r.share && <span className="muted small"> (compartilhamento {r.share})</span>}
                            </td>
                            <td>{r.principal}</td>
                            <td>
                              {r.access === 'deny' && <span className="pill bad">Negar</span>} {r.rights}
                            </td>
                            <td className="small">{r.applies_to}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              )}
            </>
          )}
        </>
      )}
    </Workspace>
  );
}

function PermLine({ r }: { r: PermRow }) {
  return (
    <tr className={r.access === 'deny' ? 'perm-deny' : undefined}>
      <td>
        {r.principal}
        <span className="muted small"> {kindLabel(r.kind)}</span>
        {r.is_new && (
          <>
            {' '}
            <span className="pill ok" title="Não existia na coleta anterior">
              Nova
            </span>
          </>
        )}
      </td>
      <td title={r.raw && r.source !== 'posix' ? `${r.raw}` : undefined}>
        {r.access === 'deny' && <span className="pill bad">Negar</span>} {r.rights}
        {r.raw && r.source === 'posix' && <span className="muted small path"> {r.raw}</span>}
      </td>
      <td className="small">{r.applies_to}</td>
      <td className="small">{r.inherited ? 'Sim' : 'Não'}</td>
    </tr>
  );
}
