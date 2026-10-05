// Inventário de permissões no portal: rótulos, agrupamento por pasta e
// filtros. Sem dependências, para testar com node --test.

export interface PermRow {
  agent_id: string;
  hostname: string;
  audited_path_id: string;
  audited_path: string;
  folder_path: string;
  depth: number;
  source: string;
  share: string | null;
  owner: string | null;
  protected: boolean;
  reason: string;
  folder_error: string | null;
  principal: string | null;
  sid: string | null;
  kind: string | null;
  access: string | null;
  rights: string | null;
  raw: string | null;
  inherited: boolean;
  applies_to: string | null;
  is_new: boolean;
}

export interface ScanInfo {
  id: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  folders_scanned: number;
  folders_recorded: number;
  truncated: boolean;
  error: string | null;
}

export interface PermAgent {
  id: string;
  hostname: string;
  os: string | null;
  agent_version: string | null;
  supported: boolean;
  requested_at: string | null;
  scanned_at: string | null;
  pending: boolean;
  paths: { id: string; path: string; scan: ScanInfo | null }[];
}

export interface PermView {
  allowed: boolean;
  interval_hours: number;
  agents: PermAgent[];
  rows: PermRow[];
  removed: PermRow[];
  truncated: boolean;
}

export interface PermFilters {
  servidor: string;
  caminho: string;
  busca: string;
  proprias: boolean;
  negacoes: boolean;
}

type SP = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.trim() ?? '';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function permFilters(sp: SP): PermFilters {
  const id = (k: string) => (UUID.test(one(sp[k])) ? one(sp[k]) : '');
  return { servidor: id('servidor'), caminho: id('caminho'), busca: one(sp.busca).slice(0, 200), proprias: one(sp.proprias) === '1', negacoes: one(sp.negacoes) === '1' };
}

// Parâmetros da API (/api/permissions).
export function permApiQuery(f: PermFilters, tenantId: string, extra: Record<string, string> = {}): string {
  const p = new URLSearchParams();
  if (tenantId) p.set('tenant', tenantId);
  if (f.servidor) p.set('agent', f.servidor);
  if (f.caminho) p.set('path', f.caminho);
  if (f.busca) p.set('q', f.busca);
  if (f.proprias) p.set('explicit', '1');
  if (f.negacoes) p.set('deny', '1');
  for (const [k, v] of Object.entries(extra)) p.set(k, v);
  return p.toString();
}

// Parâmetros da tela (/permissoes e /permissoes/exportar).
export function permScreenQuery(f: PermFilters, tenantId: string, extra: Record<string, string> = {}): string {
  const p = new URLSearchParams();
  if (tenantId) p.set('cliente', tenantId);
  if (f.servidor) p.set('servidor', f.servidor);
  if (f.caminho) p.set('caminho', f.caminho);
  if (f.busca) p.set('busca', f.busca);
  if (f.proprias) p.set('proprias', '1');
  if (f.negacoes) p.set('negacoes', '1');
  for (const [k, v] of Object.entries(extra)) p.set(k, v);
  return p.toString();
}

export interface FolderGroup {
  key: string;
  hostname: string;
  folder: string;
  source: string;
  share: string | null;
  owner: string | null;
  protected: boolean;
  reason: string;
  error: string | null;
  rows: PermRow[];
}

// Junta as linhas seguidas da mesma pasta (a API já vem ordenada).
export function groupByFolder(rows: PermRow[]): FolderGroup[] {
  const out: FolderGroup[] = [];
  for (const r of rows) {
    const key = [r.agent_id, r.folder_path, r.source, r.share ?? ''].join('|');
    let g = out[out.length - 1];
    if (!g || g.key !== key) {
      g = { key, hostname: r.hostname, folder: r.folder_path, source: r.source, share: r.share, owner: r.owner, protected: r.protected, reason: r.reason, error: r.folder_error, rows: [] };
      out.push(g);
    }
    if (r.principal !== null) g.rows.push(r);
  }
  return out;
}

// Por que a pasta aparece no inventário.
export function folderBadge(g: Pick<FolderGroup, 'source' | 'share' | 'reason' | 'protected'>): { label: string; tone: 'ok' | 'warn' | 'bad' | 'neutral' } {
  if (g.source === 'share') return { label: `Compartilhamento ${g.share ?? ''}`.trim(), tone: 'neutral' };
  switch (g.reason) {
    case 'root':
      return { label: 'Pasta auditada', tone: 'neutral' };
    case 'protected':
      return { label: 'Herança desligada', tone: 'warn' };
    case 'explicit':
      return { label: 'Permissão própria', tone: 'warn' };
    case 'changed':
      return { label: 'Diferente da pasta de cima', tone: 'warn' };
    case 'error':
      return { label: 'Não foi possível ler', tone: 'bad' };
    default:
      return { label: g.reason, tone: 'neutral' };
  }
}

export const KIND_LABELS: Record<string, string> = { user: 'Usuário', group: 'Grupo', other: 'Outros', unknown: 'Conta desconhecida' };
export const kindLabel = (k: string | null) => (k ? (KIND_LABELS[k] ?? k) : '');

// Resumo da última coleta de um caminho.
export function scanText(s: ScanInfo | null): { label: string; tone: 'ok' | 'warn' | 'bad' | 'neutral'; detail: string } {
  if (!s) return { label: 'Aguardando a primeira coleta', tone: 'neutral', detail: '' };
  if (s.status === 'error') return { label: 'Erro na coleta', tone: 'bad', detail: s.error ?? '' };
  const n = (v: number) => v.toLocaleString('pt-BR');
  const detail = `${n(s.folders_scanned)} pasta(s) lida(s), ${n(s.folders_recorded)} no inventário`;
  if (s.truncated) return { label: 'Coleta parcial', tone: 'warn', detail: `${detail}; limite de pastas atingido` };
  return { label: 'Coletado', tone: 'ok', detail };
}
