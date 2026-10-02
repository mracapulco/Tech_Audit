// Formato comum dos relatórios: a mesma tabela vira JSON (tela), Excel e PDF.

export type ColumnKind = 'text' | 'path' | 'int' | 'datetime';

export interface ReportColumn {
  key: string;
  label: string;
  kind: ColumnKind;
}

export type Cell = string | number | null;

export interface ReportTable {
  title: string;
  // Linhas de contexto: empresa, período, filtros, quem gerou.
  info: string[];
  columns: ReportColumn[];
  rows: Record<string, Cell>[];
  // Verdadeiro quando o resultado foi cortado no limite de linhas.
  truncated: boolean;
}

// Rótulos das ações. Primeiro as ações lógicas do agente 0.2+; depois os
// direitos brutos do Windows, que só aparecem em eventos de agentes 0.1.
// Tipos novos aparecem com o próprio nome até ganharem um rótulo aqui (e em
// web/lib/filters.ts).
export const ACTION_LABELS: Record<string, string> = {
  created: 'Criação',
  modified: 'Alteração',
  read: 'Leitura',
  deleted: 'Exclusão',
  recycled: 'Enviado para a Lixeira',
  renamed: 'Renomeação',
  moved: 'Movido',
  permission_changed: 'Alteração de permissão',
  owner_changed: 'Alteração de dono',
  attributes_changed: 'Alteração de atributos',
  denied: 'Acesso negado',
  write: 'Escrita (direito)',
  append: 'Acréscimo / criar subpasta (direito)',
  execute: 'Execução (direito)',
  delete: 'Exclusão (direito)',
  delete_child: 'Exclusão de item da pasta (direito)',
  write_attributes: 'Alteração de atributos (direito)',
  permission_change: 'Alteração de permissão (direito)',
  owner_change: 'Alteração de dono (direito)',
};
export const actionLabel = (a: string) => ACTION_LABELS[a] ?? a;

// Ações que o painel destaca: exclusões, Lixeira e mudanças de permissão ou
// dono (lógicas e, para agentes 0.1, os direitos equivalentes).
export const SENSITIVE_ACTIONS = [
  'deleted',
  'recycled',
  'permission_changed',
  'owner_changed',
  'delete',
  'delete_child',
  'permission_change',
  'owner_change',
];

// Ordem das colunas de ação: as conhecidas primeiro, as novas em ordem alfabética.
export function sortActions(actions: Iterable<string>): string[] {
  const known = Object.keys(ACTION_LABELS);
  const rank = (a: string) => (known.includes(a) ? known.indexOf(a) : known.length);
  return [...new Set(actions)].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

// Brasília é UTC-3 o ano inteiro desde 2019 (sem horário de verão).
export const BRT_OFFSET_MS = -3 * 3600_000;

// "2026-10-01T14:03:22.123456Z" -> "01/10/2026 11:03:22"
export function formatDateTime(iso: string): string {
  const s = new Date(new Date(iso).getTime() + BRT_OFFSET_MS).toISOString();
  return `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)} ${s.slice(11, 19)}`;
}

// Texto de uma célula para PDF e para quem não trata o tipo.
export function cellText(c: ReportColumn, v: Cell): string {
  if (v === null || v === '') return '-';
  if (c.kind === 'datetime') return formatDateTime(String(v));
  if (c.kind === 'int') return Number(v).toLocaleString('pt-BR');
  return String(v);
}
