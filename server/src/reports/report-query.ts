// SQL e regras dos relatórios e do painel, sem acesso a banco. Todos usam os
// mesmos filtros da pesquisa de eventos (eventWhere), então o escopo por
// tenant é sempre aplicado.
import { EFFECTIVE_ACTIONS_SQL as ACTS, eventWhere, paramList, type EventFilters } from '../events/event-query.js';
import { BRT_OFFSET_MS } from './table.js';

export type Bucket = 'hour' | 'day' | 'month';
const HOUR = 3600_000;
const DAY = 24 * HOUR;

// Granularidade do gráfico/relatório por período, conforme o tamanho do intervalo.
export function bucketFor(from: Date, to: Date): Bucket {
  const span = to.getTime() - from.getTime();
  if (span <= 2 * DAY) return 'hour';
  if (span <= 120 * DAY) return 'day';
  return 'month';
}

const BUCKET_FMT: Record<Bucket, string> = {
  hour: `YYYY-MM-DD"T"HH24":00"`,
  day: 'YYYY-MM-DD',
  month: 'YYYY-MM',
};

// Chave do intervalo no horário de Brasília.
export const bucketSql = (b: Bucket) => `to_char(date_trunc('${b}', e.time AT TIME ZONE 'America/Sao_Paulo'), '${BUCKET_FMT[b]}')`;

// Todas as chaves entre from e to (inclusive o intervalo parcial), para
// mostrar também os intervalos sem eventos. Limitado a `max` chaves.
export function bucketKeys(from: Date, to: Date, b: Bucket, max = 2000): string[] {
  const keys: string[] = [];
  const d = new Date(from.getTime() + BRT_OFFSET_MS);
  if (b === 'hour') d.setUTCMinutes(0, 0, 0);
  else d.setUTCHours(0, 0, 0, 0);
  if (b === 'month') d.setUTCDate(1);
  const end = to.getTime() + BRT_OFFSET_MS;
  while (d.getTime() < end && keys.length < max) {
    const s = d.toISOString();
    keys.push(b === 'hour' ? `${s.slice(0, 13)}:00` : b === 'day' ? s.slice(0, 10) : s.slice(0, 7));
    if (b === 'hour') d.setUTCHours(d.getUTCHours() + 1);
    else if (b === 'day') d.setUTCDate(d.getUTCDate() + 1);
    else d.setUTCMonth(d.getUTCMonth() + 1);
  }
  return keys;
}

// "2026-10-01T14:00" -> "01/10 14h"; "2026-10-01" -> "01/10/2026"; "2026-10" -> "10/2026"
export function bucketLabel(key: string, b: Bucket): string {
  if (b === 'hour') return `${key.slice(8, 10)}/${key.slice(5, 7)} ${key.slice(11, 13)}h`;
  if (b === 'day') return `${key.slice(8, 10)}/${key.slice(5, 7)}/${key.slice(0, 4)}`;
  return `${key.slice(5, 7)}/${key.slice(0, 4)}`;
}

// Pasta que contém o arquivo (aceita "\" do Windows e "/" do Linux).
const FOLDER_SQL = `regexp_replace(pa.path, '[\\\\/][^\\\\/]*$', '')`;

export type Query = { text: string; values: unknown[] };

export function totalsQuery(f: EventFilters, sensitive: string[]): Query {
  const { values, p } = paramList();
  const where = eventWhere(f, p);
  return {
    values,
    text: `
SELECT count(*)::float8 AS total,
       count(*) FILTER (WHERE NOT e.success)::float8 AS failures,
       count(DISTINCT e.identity_id)::float8 AS users,
       count(DISTINCT e.path_id)::float8 AS paths,
       count(*) FILTER (WHERE ${ACTS} && ${p(sensitive)}::text[])::float8 AS sensitive
FROM events.file_events e
WHERE ${where.join(' AND ')}`,
  };
}

export function timelineQuery(f: EventFilters, b: Bucket, sensitive: string[]): Query {
  const { values, p } = paramList();
  const where = eventWhere(f, p);
  return {
    values,
    text: `
SELECT ${bucketSql(b)} AS k, count(*)::float8 AS total,
       count(*) FILTER (WHERE ${ACTS} && ${p(sensitive)}::text[])::float8 AS sensitive,
       count(*) FILTER (WHERE NOT e.success)::float8 AS failures
FROM events.file_events e
WHERE ${where.join(' AND ')}
GROUP BY 1`,
  };
}

export function actionsQuery(f: EventFilters): Query {
  const { values, p } = paramList();
  const where = eventWhere(f, p);
  return {
    values,
    text: `
SELECT a AS action, count(*)::float8 AS total
FROM events.file_events e, unnest(${ACTS}) a
WHERE ${where.join(' AND ')}
GROUP BY a ORDER BY total DESC, a`,
  };
}

export function agentActivityQuery(f: EventFilters): Query {
  const { values, p } = paramList();
  const where = eventWhere(f, p);
  return {
    values,
    text: `
SELECT e.agent_id, count(*)::float8 AS total
FROM events.file_events e
WHERE ${where.join(' AND ')}
GROUP BY 1`,
  };
}

// Agrupamento genérico: `keys` são colunas de `base`; cada grupo traz também
// a contagem por ação (jsonb {acao: n}), qualquer que seja o tipo de ação.
function grouped(
  f: EventFilters,
  o: { base: string; joins?: string; keys: string[]; aggs: string; final: string; finalJoins?: string; order: string; limit?: number },
): Query {
  const { values, p } = paramList();
  const where = eventWhere(f, p);
  const match = (a: string, b: string) => o.keys.map((k) => `${a}.${k} IS NOT DISTINCT FROM ${b}.${k}`).join(' AND ');
  const keys = o.keys.join(', ');
  return {
    values,
    text: `
WITH base AS (
  SELECT ${o.base}, ${ACTS} AS actions, e.success, e.identity_id AS who, e.path_id AS what, e.time
  FROM events.file_events e ${o.joins ?? ''}
  WHERE ${where.join(' AND ')}
),
g AS (
  SELECT ${keys}, count(*)::float8 AS total, count(*) FILTER (WHERE NOT success)::float8 AS failures, ${o.aggs}
  FROM base GROUP BY ${keys}
  ORDER BY ${o.order}
  ${o.limit ? `LIMIT ${p(o.limit)}` : ''}
),
acts AS (
  SELECT ${o.keys.map((k) => 'g.' + k).join(', ')}, a, count(*)::float8 AS n
  FROM base b JOIN g ON ${match('b', 'g')}, unnest(b.actions) a
  GROUP BY ${o.keys.map((k) => 'g.' + k).join(', ')}, a
)
SELECT ${o.final},
       COALESCE((SELECT jsonb_object_agg(acts.a, acts.n) FROM acts WHERE ${match('acts', 'g')}), '{}'::jsonb) AS actions
FROM g ${o.finalJoins ?? ''}
ORDER BY ${o.order.replace(/\b(total|k)\b/g, 'g.$1')}`,
  };
}

export function usersQuery(f: EventFilters, limit: number): Query {
  return grouped(f, {
    base: 'e.tenant_id, e.identity_id',
    keys: ['tenant_id', 'identity_id'],
    aggs: `count(DISTINCT what)::float8 AS paths, to_char(min(time) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS first_time,
           to_char(max(time) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS last_time`,
    order: 'total DESC, identity_id',
    limit,
    final: `g.tenant_id, t.name AS tenant_name, i.domain AS user_domain, i.name AS user_name, i.sid AS user_sid,
            g.total, g.failures, g.paths, g.first_time, g.last_time`,
    finalJoins: 'JOIN tenants t ON t.id = g.tenant_id LEFT JOIN identities i ON i.id = g.identity_id',
  });
}

export function foldersQuery(f: EventFilters, limit: number): Query {
  return grouped(f, {
    base: `e.tenant_id, e.agent_id, lower(${FOLDER_SQL}) AS folder_key, ${FOLDER_SQL} AS folder`,
    joins: 'JOIN paths pa ON pa.id = e.path_id',
    keys: ['tenant_id', 'agent_id', 'folder_key'],
    aggs: `min(folder) AS folder, count(DISTINCT who)::float8 AS users,
           to_char(max(time) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS last_time`,
    order: 'total DESC, folder_key',
    limit,
    final: 'g.tenant_id, t.name AS tenant_name, a.hostname AS server, g.folder, g.total, g.failures, g.users, g.last_time',
    finalJoins: 'JOIN tenants t ON t.id = g.tenant_id JOIN agents a ON a.id = g.agent_id',
  });
}

export function periodQuery(f: EventFilters, b: Bucket): Query {
  return grouped(f, {
    base: `${bucketSql(b)} AS k`,
    keys: ['k'],
    aggs: 'count(DISTINCT who)::float8 AS users, count(DISTINCT what)::float8 AS paths',
    order: 'k',
    final: 'g.k, g.total, g.failures, g.users, g.paths',
  });
}

export interface GroupRow {
  actions: Record<string, number>;
  [k: string]: unknown;
}
