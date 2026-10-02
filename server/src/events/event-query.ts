// Filtros e SQL da pesquisa de eventos (docs/ARCHITECTURE.md, seção 7), sem
// acesso a banco. Paginação por cursor (keyset), nunca OFFSET.

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;
export const DEFAULT_PERIOD_MS = 7 * 24 * 3600_000;

// Ações gravadas pelo agente (agent/internal/event/access.go).
export const ACTIONS = [
  'read',
  'write',
  'append',
  'execute',
  'delete',
  'delete_child',
  'write_attributes',
  'permission_change',
  'owner_change',
] as const;

export interface EventFilters {
  // Tenants permitidos; null = todos (equipe Tech Master sem tenant escolhido).
  tenantIds: string[] | null;
  from: Date;
  to: Date;
  // Trecho de DOMINIO\usuario, ou o SID exato.
  user: string | null;
  // Prefixo do caminho, sem diferenciar maiúsculas (NTFS).
  pathPrefix: string | null;
  action: string | null;
}

export interface Cursor {
  time: string; // ISO com microssegundos, como devolvido pelo banco
  agentId: string;
  recordId: string;
}

export class FilterError extends Error {}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_US = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

type Query = Record<string, unknown>;

const text = (q: Query, name: string, max = 1024): string | null => {
  const v = q[name];
  if (v === undefined || v === '') return null;
  if (typeof v !== 'string') throw new FilterError(`${name} deve aparecer uma vez só`);
  const t = v.trim();
  if (t.length > max) throw new FilterError(`${name} muito longo`);
  return t === '' ? null : t;
};

const date = (q: Query, name: string): Date | null => {
  const v = text(q, name, 64);
  if (v === null) return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw new FilterError(`${name} não é uma data válida (use ISO 8601)`);
  return d;
};

// Lê os filtros da query string. tenantIds já vem resolvido pelo chamador,
// a partir do usuário logado.
export function parseFilters(q: Query, tenantIds: string[] | null, now = new Date()): EventFilters {
  const to = date(q, 'to') ?? now;
  const from = date(q, 'from') ?? new Date(to.getTime() - DEFAULT_PERIOD_MS);
  if (from >= to) throw new FilterError('o início do período deve ser antes do fim');
  const action = text(q, 'action', 64);
  if (action !== null && !(ACTIONS as readonly string[]).includes(action)) {
    throw new FilterError(`ação desconhecida: ${action}`);
  }
  return { tenantIds, from, to, user: text(q, 'user', 256), pathPrefix: text(q, 'path'), action };
}

export function parseLimit(v: unknown): number {
  if (v === undefined || v === '') return DEFAULT_PAGE_SIZE;
  const n = typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : NaN;
  if (!Number.isInteger(n) || n < 1 || n > MAX_PAGE_SIZE) {
    throw new FilterError(`limit deve ser de 1 a ${MAX_PAGE_SIZE}`);
  }
  return n;
}

export function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify([c.time, c.agentId, c.recordId])).toString('base64url');
}

export function decodeCursor(v: unknown): Cursor | null {
  if (v === undefined || v === '') return null;
  try {
    if (typeof v !== 'string') throw new Error();
    const a = JSON.parse(Buffer.from(v, 'base64url').toString('utf8'));
    if (
      Array.isArray(a) && a.length === 3 &&
      typeof a[0] === 'string' && ISO_US.test(a[0]) &&
      typeof a[1] === 'string' && UUID.test(a[1]) &&
      typeof a[2] === 'string' && /^\d{1,19}$/.test(a[2])
    ) {
      return { time: a[0], agentId: a[1], recordId: a[2] };
    }
  } catch {
    // cai no erro abaixo
  }
  throw new FilterError('cursor inválido');
}

// Escapa % e _ para LIKE com ESCAPE '!'. Barra invertida é comum em caminhos
// Windows, por isso não é o caractere de escape.
export const likeEscape = (s: string) => s.replace(/[!%_]/g, (c) => '!' + c);

export interface EventRow {
  time: string;
  tenant_id: string;
  tenant_name: string;
  agent_id: string;
  server: string;
  record_id: string;
  event_id: number;
  kind: string;
  path: string | null;
  user_domain: string | null;
  user_name: string | null;
  user_sid: string | null;
  actions: string[];
  success: boolean;
  share_name: string | null;
  source_ip: string | null;
  process_name: string | null;
}

export function buildEventQuery(f: EventFilters, cursor: Cursor | null, limit: number): { text: string; values: unknown[] } {
  const values: unknown[] = [];
  const p = (v: unknown) => {
    values.push(v);
    return `$${values.length}`;
  };
  const where = [`e.time >= ${p(f.from)}`, `e.time < ${p(f.to)}`];
  // Os dicionários também são filtrados por tenant: as subconsultas ficam
  // pequenas e nunca enxergam dados de outro cliente.
  let dictTenant = 'TRUE';
  if (f.tenantIds) {
    const t = p(f.tenantIds);
    where.push(`e.tenant_id = ANY(${t}::uuid[])`);
    dictTenant = `tenant_id = ANY(${t}::uuid[])`;
  }
  if (f.user) {
    const u = f.user.toLowerCase();
    where.push(
      `e.identity_id IN (SELECT id FROM identities WHERE ${dictTenant} AND ` +
        `(lower(domain || '\\' || name) LIKE ${p('%' + likeEscape(u) + '%')} ESCAPE '!' OR lower(sid) = ${p(u)}))`,
    );
  }
  if (f.pathPrefix) {
    where.push(
      `e.path_id IN (SELECT id FROM paths WHERE ${dictTenant} AND ` +
        `lower(path) LIKE ${p(likeEscape(f.pathPrefix.toLowerCase()) + '%')} ESCAPE '!')`,
    );
  }
  if (f.action) where.push(`${p(f.action)} = ANY(e.actions)`);
  if (cursor) {
    where.push(
      `(e.time, e.agent_id, e.source_record_id) < (${p(cursor.time)}::timestamptz, ${p(cursor.agentId)}::uuid, ${p(cursor.recordId)}::bigint)`,
    );
  }
  const text = `
SELECT to_char(e.time AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS time,
       e.tenant_id, t.name AS tenant_name, e.agent_id, a.hostname AS server,
       e.source_record_id::text AS record_id, e.source_event_id AS event_id, e.kind,
       pa.path, i.domain AS user_domain, i.name AS user_name, i.sid AS user_sid,
       e.actions, e.success, e.share_name, host(e.source_ip) AS source_ip, e.process_name
FROM events.file_events e
JOIN agents a ON a.id = e.agent_id
JOIN tenants t ON t.id = e.tenant_id
LEFT JOIN paths pa ON pa.id = e.path_id
LEFT JOIN identities i ON i.id = e.identity_id
WHERE ${where.join('\n  AND ')}
ORDER BY e.time DESC, e.agent_id DESC, e.source_record_id DESC
LIMIT ${p(limit)}`;
  return { text, values };
}

export const cursorOf = (r: EventRow): Cursor => ({ time: r.time, agentId: r.agent_id, recordId: r.record_id });
