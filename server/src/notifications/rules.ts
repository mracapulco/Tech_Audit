// Regras dos alertas por e-mail e dos relatórios agendados, sem acesso a banco.
import { BadRequestException } from '@nestjs/common';
import { ACTION_NAME } from '../events/event-query.js';
import { BRT_OFFSET_MS } from '../reports/table.js';
import { REPORT_TYPES, type ReportType } from '../reports/reports.service.js';

const HOUR = 3600_000;
const DAY = 24 * HOUR;

// --- Alertas ---------------------------------------------------------------

// Grupos que a empresa liga ou desliga na tela; cada um junta tipos de alerta
// (coluna alerts.kind).
export const ALERT_GROUPS = {
  agent_offline: {
    label: 'Servidor parou de enviar dados (e quando volta)',
    kinds: ['agent_offline', 'agent_online'],
    default: true,
  },
  mass_delete: {
    label: 'Exclusão em massa de arquivos por um usuário',
    kinds: ['mass_delete'],
    default: true,
  },
  volume: {
    label: 'Volume auditado em 80% ou 100% do contratado',
    kinds: ['volume_80', 'volume_100'],
    default: true,
  },
  audit_error: {
    label: 'Erro ou divergência na auditoria de uma pasta',
    kinds: ['audit_config_error', 'audit_config_divergent'],
    default: true,
  },
  audit_changed: {
    label: 'Auditoria aplicada ou removida em uma pasta',
    kinds: ['audit_config_changed'],
    default: false,
  },
} as const;

export type AlertGroup = keyof typeof ALERT_GROUPS;
export const ALERT_GROUP_KEYS = Object.keys(ALERT_GROUPS) as AlertGroup[];
export const DEFAULT_ALERT_GROUPS = ALERT_GROUP_KEYS.filter((g) => ALERT_GROUPS[g].default);

// Tipos de alerta que vão por e-mail com os grupos escolhidos.
export function kindsFor(groups: string[]): Set<string> {
  return new Set(ALERT_GROUP_KEYS.filter((g) => groups.includes(g)).flatMap((g) => [...ALERT_GROUPS[g].kinds]));
}

export const MASS_DELETE_DEFAULTS = { threshold: 100, windowMinutes: 10 };
// A detecção olha no máximo esta janela para trás.
export const MASS_DELETE_MAX_WINDOW = 60;

// Exclusões contadas por minuto (consulta do serviço). Soma as da janela de
// cada empresa e devolve quem passou do limite.
export interface DeleteMinute {
  tenant_id: string;
  identity_id: string;
  user_text: string;
  minute: Date;
  total: number;
  servers: string[];
}

export interface MassDelete {
  tenantId: string;
  identityId: string;
  user: string;
  total: number;
  servers: string[];
  from: Date;
  to: Date;
}

export function massDeletes(rows: DeleteMinute[], settings: (tenantId: string) => { threshold: number; windowMinutes: number }, now: Date): MassDelete[] {
  const acc = new Map<string, MassDelete>();
  for (const r of rows) {
    const s = settings(r.tenant_id);
    if (r.minute.getTime() < now.getTime() - s.windowMinutes * 60_000) continue;
    const key = `${r.tenant_id}|${r.identity_id}`;
    const m = acc.get(key) ?? { tenantId: r.tenant_id, identityId: String(r.identity_id), user: r.user_text, total: 0, servers: [], from: r.minute, to: r.minute };
    m.total += r.total;
    m.servers = [...new Set([...m.servers, ...r.servers])].sort();
    if (r.minute < m.from) m.from = r.minute;
    if (r.minute > m.to) m.to = r.minute;
    acc.set(key, m);
  }
  return [...acc.values()].filter((m) => m.total >= settings(m.tenantId).threshold);
}

// --- Endereços de e-mail ----------------------------------------------------

export const MAX_RECIPIENTS = 10;
const EMAIL = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

// Aceita lista ou texto separado por vírgula, ponto e vírgula, espaço ou linha.
export function parseRecipients(v: unknown, required: boolean): string[] {
  let items: string[];
  if (v === undefined || v === null) items = [];
  else if (typeof v === 'string') items = v.split(/[\s,;]+/);
  else if (Array.isArray(v) && v.every((x) => typeof x === 'string')) items = v as string[];
  else throw new BadRequestException('destinatários inválidos');
  const list = [...new Set(items.map((x) => x.trim().toLowerCase()).filter(Boolean))];
  for (const e of list) {
    if (e.length > 254 || !EMAIL.test(e)) throw new BadRequestException(`e-mail inválido: ${e.slice(0, 80)}`);
  }
  if (list.length > MAX_RECIPIENTS) throw new BadRequestException(`no máximo ${MAX_RECIPIENTS} destinatários`);
  if (required && list.length === 0) throw new BadRequestException('informe pelo menos um destinatário');
  return list;
}

type Input = Record<string, unknown>;

const int = (b: Input, name: string, label: string, min: number, max: number): number | undefined => {
  const v = b[name];
  if (v === undefined || v === null || v === '') return undefined;
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v) : NaN;
  if (!Number.isInteger(n) || n < min || n > max) throw new BadRequestException(`${label} deve ser um número de ${min} a ${max}`);
  return n;
};

export interface AlertSettingsInput {
  recipients: string[];
  groups: string[];
  massDeleteThreshold: number;
  massDeleteWindowMinutes: number;
}

export function parseAlertSettings(b: Input): AlertSettingsInput {
  const g = b.groups;
  if (g !== undefined && !(Array.isArray(g) && g.every((x) => typeof x === 'string'))) throw new BadRequestException('tipos de alerta inválidos');
  const groups = ((g as string[] | undefined) ?? []).filter((x, i, a) => a.indexOf(x) === i);
  for (const x of groups) if (!ALERT_GROUP_KEYS.includes(x as AlertGroup)) throw new BadRequestException(`tipo de alerta desconhecido: ${x}`);
  return {
    recipients: parseRecipients(b.recipients, false),
    groups,
    massDeleteThreshold: int(b, 'mass_delete_threshold', 'O limite de exclusões', 10, 100_000) ?? MASS_DELETE_DEFAULTS.threshold,
    massDeleteWindowMinutes: int(b, 'mass_delete_window_minutes', 'A janela de tempo', 1, MASS_DELETE_MAX_WINDOW) ?? MASS_DELETE_DEFAULTS.windowMinutes,
  };
}

// --- Relatórios agendados ---------------------------------------------------

export const FREQUENCIES = ['daily', 'weekly', 'monthly'] as const;
export type Frequency = (typeof FREQUENCIES)[number];
export const SCHEDULE_FORMATS = ['pdf', 'xlsx'] as const;

export interface Schedule {
  frequency: Frequency;
  // 1 = segunda ... 7 = domingo (semanal).
  weekday: number | null;
  hour: number;
}

export interface ScheduleInput extends Schedule {
  name: string;
  reportType: ReportType;
  format: (typeof SCHEDULE_FORMATS)[number];
  filterUser: string | null;
  filterPath: string | null;
  filterAction: string | null;
  recipients: string[];
  enabled: boolean;
}

const optText = (b: Input, name: string, max: number): string | null => {
  const v = b[name];
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') throw new BadRequestException(`${name} inválido`);
  const t = v.trim();
  if (t.length > max) throw new BadRequestException(`${name} muito longo`);
  return t || null;
};

export function parseSchedule(b: Input): ScheduleInput {
  const name = optText(b, 'name', 120);
  if (!name) throw new BadRequestException('informe um nome para o relatório agendado');
  const reportType = b.report_type as ReportType;
  if (!(REPORT_TYPES as readonly unknown[]).includes(reportType)) throw new BadRequestException('tipo de relatório inválido');
  const format = b.format as ScheduleInput['format'];
  if (!(SCHEDULE_FORMATS as readonly unknown[]).includes(format)) throw new BadRequestException('formato deve ser pdf ou xlsx');
  const frequency = b.frequency as Frequency;
  if (!(FREQUENCIES as readonly unknown[]).includes(frequency)) throw new BadRequestException('frequência deve ser diária, semanal ou mensal');
  const hour = int(b, 'hour', 'A hora do envio', 0, 23) ?? 7;
  const weekday = frequency === 'weekly' ? (int(b, 'weekday', 'O dia da semana', 1, 7) ?? 1) : null;
  const filterAction = optText(b, 'filter_action', 64);
  if (filterAction && !ACTION_NAME.test(filterAction)) throw new BadRequestException('ação inválida');
  const enabled = b.enabled === undefined ? true : b.enabled === true;
  return {
    name,
    reportType,
    format,
    frequency,
    weekday,
    hour,
    filterUser: optText(b, 'filter_user', 256),
    filterPath: optText(b, 'filter_path', 1024),
    filterAction,
    recipients: parseRecipients(b.recipients, true),
    enabled,
  };
}

// Data/hora "de parede" em Brasília (horário fixo UTC-3, sem horário de verão).
const wall = (d: Date) => new Date(d.getTime() + BRT_OFFSET_MS);
const fromWall = (w: Date) => new Date(w.getTime() - BRT_OFFSET_MS);

// Próximo envio depois de `after`. Diário: todo dia na hora; semanal: no dia
// da semana; mensal: no dia 1.
export function nextRun(s: Schedule, after: Date): Date {
  const w = wall(after);
  const c = new Date(Date.UTC(w.getUTCFullYear(), w.getUTCMonth(), w.getUTCDate(), s.hour));
  if (s.frequency === 'monthly') {
    c.setUTCDate(1);
    if (c <= w) c.setUTCMonth(c.getUTCMonth() + 1);
    return fromWall(c);
  }
  if (s.frequency === 'weekly') {
    const target = (s.weekday ?? 1) % 7; // getUTCDay: 0 = domingo
    while (c.getUTCDay() !== target || c <= w) c.setUTCDate(c.getUTCDate() + 1);
    return fromWall(c);
  }
  if (c <= w) c.setUTCDate(c.getUTCDate() + 1);
  return fromWall(c);
}

// Período coberto por um envio em `at`: dias inteiros de Brasília antes do
// dia do envio. Diário = ontem; semanal = os 7 dias anteriores; mensal = o
// mês anterior.
export function reportPeriod(frequency: Frequency, at: Date): { from: Date; to: Date } {
  const w = wall(at);
  const today = new Date(Date.UTC(w.getUTCFullYear(), w.getUTCMonth(), w.getUTCDate()));
  if (frequency === 'monthly') {
    const to = new Date(Date.UTC(w.getUTCFullYear(), w.getUTCMonth(), 1));
    const from = new Date(Date.UTC(w.getUTCFullYear(), w.getUTCMonth() - 1, 1));
    return { from: fromWall(from), to: fromWall(to) };
  }
  const days = frequency === 'weekly' ? 7 : 1;
  return { from: fromWall(new Date(today.getTime() - days * DAY)), to: fromWall(today) };
}

const WEEKDAYS = ['', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado', 'domingo'];

export function scheduleLabel(s: Schedule): string {
  const h = `${String(s.hour).padStart(2, '0')}:00`;
  if (s.frequency === 'monthly') return `Todo dia 1º, às ${h} (mês anterior)`;
  if (s.frequency === 'weekly') return `Toda ${WEEKDAYS[s.weekday ?? 1]}, às ${h} (7 dias anteriores)`;
  return `Todo dia, às ${h} (dia anterior)`;
}

// "05/10/2026"
export function formatDay(d: Date): string {
  const s = wall(d).toISOString();
  return `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)}`;
}

// Período legível: o fim é exclusivo (meia-noite do dia seguinte).
export function periodLabel(p: { from: Date; to: Date }): string {
  const last = new Date(p.to.getTime() - 1);
  const a = formatDay(p.from);
  const b = formatDay(last);
  return a === b ? a : `${a} a ${b}`;
}
