import type { EventRow } from './event-query.js';

// CSV para abrir direto no Excel em português: separador ";" (a vírgula é o
// separador decimal), UTF-8 com BOM e horário de Brasília.
export const CSV_BOM = '﻿';
export const CSV_SEPARATOR = ';';

export const CSV_HEADER = [
  'Data/hora (Brasília)',
  'Cliente',
  'Servidor',
  'Usuário',
  'SID',
  'Ação',
  'Caminho',
  'Novo caminho',
  'Quantidade',
  'Direitos de acesso',
  'Resultado',
  'Compartilhamento',
  'IP de origem',
  'Processo',
  'Evento Windows',
  'Record ID',
];

const brasilia = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'America/Sao_Paulo',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

// "2026-10-01T14:03:22.123456Z" -> "2026-10-01 11:03:22"
export const formatBrasilia = (iso: string) => brasilia.format(new Date(iso));

export function csvCell(v: string | number | null | undefined): string {
  let s = v === null || v === undefined ? '' : String(v);
  // Evita injeção de fórmula ao abrir no Excel (=, +, -, @, tab, CR).
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[";\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const csvLine = (cells: (string | number | null | undefined)[]) =>
  cells.map(csvCell).join(CSV_SEPARATOR) + '\r\n';

// Nome da ação lógica em português, como aparece no relatório.
export const ACTION_NAMES: Record<string, string> = {
  created: 'Criou',
  modified: 'Alterou',
  read: 'Leu',
  deleted: 'Excluiu',
  recycled: 'Moveu para a Lixeira',
  renamed: 'Renomeou',
  moved: 'Moveu',
  permission_changed: 'Alterou permissões',
  owner_changed: 'Alterou o dono',
  attributes_changed: 'Alterou atributos',
  denied: 'Acesso negado',
};

export function eventCsvLine(r: EventRow): string {
  const user = r.user_name ? (r.user_domain ? `${r.user_domain}\\${r.user_name}` : r.user_name) : '';
  return csvLine([
    formatBrasilia(r.time),
    r.tenant_name,
    r.server,
    user,
    r.user_sid,
    r.action ? (ACTION_NAMES[r.action] ?? r.action) : '',
    r.path,
    r.new_path,
    r.count,
    r.actions.join(', '),
    r.success ? 'sucesso' : 'falha',
    r.share_name,
    r.source_ip,
    r.process_name,
    r.event_id,
    r.record_id,
  ]);
}
