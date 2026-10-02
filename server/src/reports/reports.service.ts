import { Injectable } from '@nestjs/common';
import { buildEventQuery, type EventFilters, type EventRow } from '../events/event-query.js';
import { evaluateLicenses } from '../licensing/license.js';
import { PgService } from '../db/pg.service.js';
import { PrismaService } from '../prisma.service.js';
import {
  actionsQuery,
  agentActivityQuery,
  bucketFor,
  bucketKeys,
  bucketLabel,
  foldersQuery,
  periodQuery,
  timelineQuery,
  totalsQuery,
  usersQuery,
  type GroupRow,
  type Query,
} from './report-query.js';
import { actionLabel, formatDateTime, SENSITIVE_ACTIONS, sortActions, type Cell, type ReportColumn, type ReportTable } from './table.js';

export const REPORT_TYPES = ['usuarios', 'pastas', 'periodo', 'eventos'] as const;
export type ReportType = (typeof REPORT_TYPES)[number];

export const REPORT_TITLES: Record<ReportType, string> = {
  usuarios: 'Atividade por usuário',
  pastas: 'Atividade por pasta',
  periodo: 'Atividade por período',
  eventos: 'Eventos detalhados',
};

// Agente sem enviar lotes há mais que isso aparece em alerta no painel. O
// agente só fala com o servidor quando há eventos, então "atrasado" pode ser
// só um servidor sem uso; "parado" (mais de um dia) merece verificação.
export const AGENT_LATE_MS = 3600_000;
export const AGENT_STALE_MS = 24 * 3600_000;

export type AgentHealth = 'ok' | 'late' | 'stale' | 'never' | 'disabled';

export function agentHealth(a: { lastSeenAt: Date | null; disabledAt: Date | null }, now = new Date()): AgentHealth {
  if (a.disabledAt) return 'disabled';
  if (!a.lastSeenAt) return 'never';
  const age = now.getTime() - a.lastSeenAt.getTime();
  return age <= AGENT_LATE_MS ? 'ok' : age <= AGENT_STALE_MS ? 'late' : 'stale';
}

export interface ReportContext {
  // Nome da empresa quando o escopo é um único tenant.
  tenantName: string | null;
  userName: string;
  now?: Date;
}

const userText = (r: { user_domain?: unknown; user_name?: unknown } | GroupRow) =>
  r.user_name ? (r.user_domain ? `${r.user_domain}\\${r.user_name}` : String(r.user_name)) : '(não identificado)';

// Linhas de contexto que vão no topo da planilha e do PDF.
export function reportInfo(f: EventFilters, ctx: ReportContext): string[] {
  const filters: string[] = [];
  if (f.user) filters.push(`usuário contém "${f.user}"`);
  if (f.pathPrefix) filters.push(`caminho começa com "${f.pathPrefix}"`);
  if (f.action) filters.push(`ação: ${actionLabel(f.action)}`);
  const lines = [
    `Empresa: ${ctx.tenantName ?? 'todas'}`,
    `Período: ${formatDateTime(f.from.toISOString())} a ${formatDateTime(f.to.toISOString())} (horário de Brasília)`,
  ];
  if (filters.length) lines.push(`Filtros: ${filters.join('; ')}`);
  lines.push(`Gerado em ${formatDateTime((ctx.now ?? new Date()).toISOString())} por ${ctx.userName}`);
  return lines;
}

const col = (key: string, label: string, kind: ReportColumn['kind'] = 'text'): ReportColumn => ({ key, label, kind });

// Acrescenta uma coluna por tipo de ação presente no resultado.
function withActions(columns: ReportColumn[], rows: GroupRow[]): { columns: ReportColumn[]; actions: string[] } {
  const actions = sortActions(rows.flatMap((r) => Object.keys(r.actions ?? {})));
  return { columns: [...columns, ...actions.map((a) => col(`action:${a}`, actionLabel(a), 'int'))], actions };
}

function actionCells(r: GroupRow, actions: string[]): Record<string, Cell> {
  return Object.fromEntries(actions.map((a) => [`action:${a}`, r.actions?.[a] ?? 0]));
}

@Injectable()
export class ReportsService {
  constructor(
    private readonly pg: PgService,
    private readonly prisma: PrismaService,
  ) {}

  private async rows<T>(q: Query): Promise<T[]> {
    return (await this.pg.query(q.text, q.values)).rows as T[];
  }

  // Monta o relatório pedido; `max` linhas no máximo (truncated indica corte).
  async report(type: ReportType, f: EventFilters, max: number, ctx: ReportContext): Promise<ReportTable> {
    const many = !ctx.tenantName;
    const tenantCol = many ? [col('tenant_name', 'Empresa')] : [];
    const base = { title: REPORT_TITLES[type], info: reportInfo(f, ctx) };

    if (type === 'eventos') {
      const q = buildEventQuery(f, null, max + 1);
      const all = await this.rows<EventRow>(q);
      const rows = all.slice(0, max).map((r) => ({
        time: r.time,
        tenant_name: r.tenant_name,
        server: r.server,
        user: userText(r),
        path: r.path,
        actions: r.actions.map(actionLabel).join(', '),
        result: r.success ? 'Sucesso' : 'Falha',
        source_ip: r.source_ip,
        process_name: r.process_name,
      }));
      return {
        ...base,
        columns: [
          col('time', 'Data/hora', 'datetime'),
          ...tenantCol,
          col('server', 'Servidor'),
          col('user', 'Usuário'),
          col('path', 'Caminho', 'path'),
          col('actions', 'Ações'),
          col('result', 'Resultado'),
          col('source_ip', 'IP de origem'),
          col('process_name', 'Processo', 'path'),
        ],
        rows,
        truncated: all.length > max,
      };
    }

    if (type === 'usuarios') {
      const all = await this.rows<GroupRow>(usersQuery(f, max + 1));
      const list = all.slice(0, max);
      const { columns, actions } = withActions(
        [
          ...tenantCol,
          col('user', 'Usuário'),
          col('user_sid', 'SID'),
          col('total', 'Eventos', 'int'),
          col('failures', 'Falhas', 'int'),
          col('paths', 'Caminhos distintos', 'int'),
          col('first_time', 'Primeiro evento', 'datetime'),
          col('last_time', 'Último evento', 'datetime'),
        ],
        list,
      );
      const rows = list.map((r) => ({
        tenant_name: r.tenant_name as string,
        user: userText(r),
        user_sid: (r.user_sid as string | null) ?? null,
        total: r.total as number,
        failures: r.failures as number,
        paths: r.paths as number,
        first_time: r.first_time as string,
        last_time: r.last_time as string,
        ...actionCells(r, actions),
      }));
      return { ...base, columns, rows, truncated: all.length > max };
    }

    if (type === 'pastas') {
      const all = await this.rows<GroupRow>(foldersQuery(f, max + 1));
      const list = all.slice(0, max);
      const { columns, actions } = withActions(
        [
          ...tenantCol,
          col('server', 'Servidor'),
          col('folder', 'Pasta', 'path'),
          col('total', 'Eventos', 'int'),
          col('failures', 'Falhas', 'int'),
          col('users', 'Usuários', 'int'),
          col('last_time', 'Último evento', 'datetime'),
        ],
        list,
      );
      const rows = list.map((r) => ({
        tenant_name: r.tenant_name as string,
        server: r.server as string,
        folder: (r.folder as string) || '(raiz)',
        total: r.total as number,
        failures: r.failures as number,
        users: r.users as number,
        last_time: r.last_time as string,
        ...actionCells(r, actions),
      }));
      return { ...base, columns, rows, truncated: all.length > max };
    }

    // periodo: um intervalo por linha, inclusive os sem eventos.
    const b = bucketFor(f.from, f.to);
    const found = new Map((await this.rows<GroupRow>(periodQuery(f, b))).map((r) => [r.k as string, r]));
    const keys = bucketKeys(f.from, f.to, b);
    const list = keys.map((k) => found.get(k) ?? { k, total: 0, failures: 0, users: 0, paths: 0, actions: {} });
    const { columns, actions } = withActions(
      [
        col('period', b === 'hour' ? 'Hora' : b === 'day' ? 'Dia' : 'Mês'),
        col('total', 'Eventos', 'int'),
        col('failures', 'Falhas', 'int'),
        col('users', 'Usuários', 'int'),
        col('paths', 'Caminhos distintos', 'int'),
      ],
      list,
    );
    const rows = list.slice(0, max).map((r) => ({
      period: bucketLabel(r.k as string, b),
      total: r.total as number,
      failures: r.failures as number,
      users: r.users as number,
      paths: r.paths as number,
      ...actionCells(r, actions),
    }));
    return { ...base, columns, rows, truncated: list.length > max };
  }

  // Painel inicial: resumo do período, gráficos e saúde dos agentes.
  async dashboard(f: EventFilters, now = new Date()) {
    const b = bucketFor(f.from, f.to);
    const sensitive: EventFilters = { ...f, anyActions: SENSITIVE_ACTIONS };
    const [totals, timeline, actions, users, folders, recent, activity] = await Promise.all([
      this.rows<Record<string, number>>(totalsQuery(f, SENSITIVE_ACTIONS)),
      this.rows<{ k: string; total: number; sensitive: number; failures: number }>(timelineQuery(f, b, SENSITIVE_ACTIONS)),
      this.rows<{ action: string; total: number }>(actionsQuery(f)),
      this.rows<GroupRow>(usersQuery(f, 8)),
      this.rows<GroupRow>(foldersQuery(f, 8)),
      this.rows<EventRow>(buildEventQuery(sensitive, null, 10)),
      this.rows<{ agent_id: string; total: number }>(agentActivityQuery(f)),
    ]);

    const byKey = new Map(timeline.map((t) => [t.k, t]));
    const tenantWhere = f.tenantIds ? { id: { in: f.tenantIds } } : {};
    const tenants = await this.prisma.tenant.findMany({
      where: tenantWhere,
      orderBy: { name: 'asc' },
      include: { licenses: true, agents: { orderBy: { hostname: 'asc' } } },
    });
    const eventsByAgent = new Map(activity.map((a) => [a.agent_id, a.total]));

    const agents = tenants.flatMap((t) =>
      t.agents.map((a) => ({
        id: a.id,
        tenant_id: t.id,
        tenant_name: t.name,
        hostname: a.hostname,
        os: a.os,
        agent_version: a.agentVersion,
        last_seen_at: a.lastSeenAt,
        health: agentHealth(a, now),
        events: eventsByAgent.get(a.id) ?? 0,
      })),
    );

    const companies = tenants.map((t) => {
      const s = evaluateLicenses(t.licenses, now);
      const active = t.agents.filter((a) => !a.disabledAt);
      return {
        id: t.id,
        name: t.name,
        license: {
          status: s.status,
          max_agents: s.maxAgents,
          max_volume_bytes: s.maxVolumeBytes.toString(),
          valid_until: s.validUntil,
          grace_until: s.graceUntil,
          active_agents: active.length,
        },
        agents_attention: active.filter((a) => ['stale', 'never'].includes(agentHealth(a, now))).length,
        events: t.agents.reduce((n, a) => n + (eventsByAgent.get(a.id) ?? 0), 0),
      };
    });

    const pick = (r: GroupRow, keys: string[]) => Object.fromEntries(keys.map((k) => [k, r[k] ?? null]));
    return {
      period: { from: f.from, to: f.to, bucket: b },
      totals: totals[0],
      timeline: bucketKeys(f.from, f.to, b).map((k) => ({
        key: k,
        label: bucketLabel(k, b),
        total: byKey.get(k)?.total ?? 0,
        sensitive: byKey.get(k)?.sensitive ?? 0,
        failures: byKey.get(k)?.failures ?? 0,
      })),
      actions: actions.map((a) => ({ ...a, label: actionLabel(a.action) })),
      top_users: users.map((u) => ({ ...pick(u, ['tenant_id', 'tenant_name', 'user_domain', 'user_name', 'user_sid', 'total', 'failures']) })),
      top_folders: folders.map((x) => ({ ...pick(x, ['tenant_id', 'tenant_name', 'server', 'folder', 'total', 'users']) })),
      recent_sensitive: recent,
      sensitive_actions: SENSITIVE_ACTIONS,
      agents,
      companies,
    };
  }
}
