// Espaço da empresa: a empresa escolhida vai no parâmetro "cliente" de todas
// as telas, e as abas mudam conforme o perfil. Sem dependências, para testar
// com node --test.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type TabKey = 'painel' | 'eventos' | 'relatorios' | 'permissoes' | 'servidores' | 'usuarios' | 'licenca';

export interface Tab {
  key: TabKey;
  label: string;
  path: string;
  // Separada das demais: só a Tech Master vê.
  admin?: boolean;
}

const ALL_TABS: Tab[] = [
  { key: 'painel', label: 'Painel', path: '/painel' },
  { key: 'eventos', label: 'Eventos', path: '/eventos' },
  { key: 'relatorios', label: 'Relatórios', path: '/relatorios' },
  { key: 'permissoes', label: 'Permissões', path: '/permissoes' },
  { key: 'servidores', label: 'Servidores', path: '/servidores' },
  { key: 'usuarios', label: 'Usuários', path: '/usuarios', admin: true },
  { key: 'licenca', label: 'Licença e contrato', path: '/licenca', admin: true },
];

// Telas que valem para "Todas as empresas" (sem empresa escolhida).
const ALL_COMPANIES: TabKey[] = ['painel', 'eventos', 'relatorios'];

export const isMspRole = (role: string) => role === 'msp_admin' || role === 'msp_operator';

// Abas visíveis. Usuários e licença são do administrador da Tech Master; sem
// empresa escolhida, só as telas que juntam todas as empresas.
export function workspaceTabs(role: string, hasTenant: boolean): Tab[] {
  return ALL_TABS.filter((t) => (!t.admin || role === 'msp_admin') && (hasTenant || ALL_COMPANIES.includes(t.key)));
}

// Empresa da URL. "empresa" é o nome antigo, de links salvos antes das abas.
export function tenantParam(sp: Record<string, string | string[] | undefined>): string {
  for (const k of ['cliente', 'empresa']) {
    const v = sp[k];
    const s = (Array.isArray(v) ? v[0] : v)?.trim() ?? '';
    if (UUID.test(s)) return s;
  }
  return '';
}

// Link de uma tela com a empresa e outros parâmetros.
export function withTenant(path: string, tenantId: string, extra: Record<string, string> = {}): string {
  const p = new URLSearchParams();
  if (tenantId) p.set('cliente', tenantId);
  for (const [k, v] of Object.entries(extra)) if (v) p.set(k, v);
  const q = p.toString();
  return q ? `${path}?${q}` : path;
}

// Ao trocar de empresa, fica na mesma aba quando ela existe para a nova
// escolha; senão, vai para o painel.
export function switchTarget(pathname: string, role: string, tenantId: string): string {
  const tab = workspaceTabs(role, !!tenantId).find((t) => pathname === t.path || pathname.startsWith(t.path + '/'));
  return withTenant(tab ? tab.path : '/painel', tenantId);
}
