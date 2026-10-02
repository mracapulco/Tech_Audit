// Conversão entre os filtros da tela (horário de Brasília, nomes em
// português) e os parâmetros da API. Sem dependências, para testar com node --test.

export const ACTION_LABELS: Record<string, string> = {
  write: 'Escrita',
  append: 'Acréscimo / criar subpasta',
  delete: 'Exclusão',
  delete_child: 'Exclusão de item da pasta',
  read: 'Leitura',
  execute: 'Execução',
  write_attributes: 'Alteração de atributos',
  permission_change: 'Alteração de permissão',
  owner_change: 'Alteração de dono',
};

export const actionLabel = (a: string) => ACTION_LABELS[a] ?? a;

// Brasília é UTC-3 o ano inteiro desde 2019 (sem horário de verão).
const BRT_OFFSET_MS = -3 * 3600_000;

// "2026-10-01T08:00" (campo datetime-local, Brasília) -> ISO UTC.
export function localToIso(v: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v)) return null;
  const d = new Date(`${v}:00-03:00`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// Date -> "2026-10-01T08:00" em Brasília, para preencher o campo.
export function isoToLocal(d: Date): string {
  return new Date(d.getTime() + BRT_OFFSET_MS).toISOString().slice(0, 16);
}

// "2026-10-01T14:03:22.123456Z" -> "01/10/2026 11:03:22"
export function formatDateTime(iso: string): string {
  const s = new Date(new Date(iso).getTime() + BRT_OFFSET_MS).toISOString();
  return `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)} ${s.slice(11, 19)}`;
}

export type SearchParams = Record<string, string | string[] | undefined>;

export interface ScreenFilters {
  cliente: string;
  usuario: string;
  caminho: string;
  acao: string;
  de: string;
  ate: string;
}

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.trim() ?? '';

// Filtros da URL, com o período padrão dos últimos 7 dias.
export function screenFilters(sp: SearchParams, now = new Date()): ScreenFilters {
  return {
    cliente: one(sp.cliente),
    usuario: one(sp.usuario),
    caminho: one(sp.caminho),
    acao: one(sp.acao),
    de: one(sp.de) || isoToLocal(new Date(now.getTime() - 7 * 24 * 3600_000)),
    ate: one(sp.ate) || isoToLocal(now),
  };
}

// Parâmetros da API (/api/events e /api/events/export.csv).
export function apiParams(f: ScreenFilters, extra: Record<string, string> = {}): URLSearchParams {
  const p = new URLSearchParams();
  if (f.cliente) p.set('tenant', f.cliente);
  if (f.usuario) p.set('user', f.usuario);
  if (f.caminho) p.set('path', f.caminho);
  if (f.acao) p.set('action', f.acao);
  const from = localToIso(f.de);
  const to = localToIso(f.ate);
  if (from) p.set('from', from);
  if (to) p.set('to', to);
  for (const [k, v] of Object.entries(extra)) if (v) p.set(k, v);
  return p;
}

// Query string da própria tela (para links de página e exportação).
export function screenQuery(f: ScreenFilters, extra: Record<string, string> = {}): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...f, ...extra })) if (v) p.set(k, v);
  return p.toString();
}

// Atalhos de período usados no painel, nos relatórios e na pesquisa.
export const PERIOD_PRESETS: { key: string; label: string; hours: number }[] = [
  { key: '24h', label: 'Últimas 24 horas', hours: 24 },
  { key: '7d', label: '7 dias', hours: 7 * 24 },
  { key: '30d', label: '30 dias', hours: 30 * 24 },
  { key: '90d', label: '90 dias', hours: 90 * 24 },
];

// Período de um atalho, nos campos "de"/"até" da tela (Brasília).
export function presetRange(key: string, now = new Date()): { de: string; ate: string } | null {
  const p = PERIOD_PRESETS.find((x) => x.key === key);
  if (!p) return null;
  return { de: isoToLocal(new Date(now.getTime() - p.hours * 3600_000)), ate: isoToLocal(now) };
}

// Opções de ação do filtro, incluindo a escolhida quando é um tipo novo do agente.
export function actionOptions(selected: string): [string, string][] {
  const list = Object.entries(ACTION_LABELS);
  if (selected && !ACTION_LABELS[selected]) list.push([selected, selected]);
  return list;
}
